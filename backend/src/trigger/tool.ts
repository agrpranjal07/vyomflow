/**
 * Per-tool-invocation Trigger.dev child task (assignment §7: "long-running
 * media work runs as typed child tasks"). Triggered by the parent turn task
 * via `triggerAndWait` with `idempotencyKey = toolInvocationId` (architecture.md
 * LOCKED decision). Owns the ToolInvocation row's dispatch/run lifecycle;
 * credit capture and the `tool_result` content-block write happen in the
 * parent, in the same transaction (S3 implementation plan §5.3), so
 * settlement and persistence cannot partially apply.
 *
 * VyomFlow rewrite (Phase 3 Task 3.2): the three real tools (crop_image,
 * generate_image, merge_videos) now run in-process against local/free
 * engines (sharp, Cloudflare Workers AI, ffmpeg) instead of being dispatched
 * to a remote reference-implementation run — this task's job is now "run `tool.execute()`
 * inside a bounded workDir/signal, then settle the row", not "POST + poll a
 * remote run". Single attempt only, same reasoning as before: a crash
 * mid-execute must never be blindly retried, since there is no way to know
 * whether the engine's side effects (e.g. a partially-written ffmpeg output)
 * are safe to redo — a row found RUNNING (not DISPATCHING, not terminal) on
 * re-entry is exactly that ambiguous window, and is failed closed rather
 * than re-executed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { getToolDefinition } from "@/server/tools/registry";
import { classifyMediaToolError } from "@/server/tools/errors";
import { markToolRunning, markToolCompleted, markToolFailed, markToolCancelled } from "@/services/tool-invocations";
import {
  MEDIA_TOOL_TASK_MAX_DURATION_S,
  MEDIA_TOOL_QUEUE_CONCURRENCY,
  MEDIA_TOOL_EXEC_DEADLINE_MS,
  SHARP_CROP_BUDGET_MS,
  GENERATE_IMAGE_BUDGET_MS,
  MERGE_VIDEOS_BUDGET_MS,
} from "@/lib/config";
import { ingestGeneratedAssets } from "@/server/transloadit/ingest";
import { uploadGeneratedArtifacts } from "@/server/transloadit/upload";
import type { MediaArtifact, MediaEngine } from "@/server/tools/registry";

export interface MediaToolTaskPayload {
  toolInvocationId: string;
}

export interface MediaToolTaskResult {
  status: "COMPLETED" | "FAILED";
  resultUrls: string[];
  creditUsedApp: number;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

const ENGINE_BUDGET_MS: Record<MediaEngine, number> = {
  sharp: SHARP_CROP_BUDGET_MS,
  cloudflare: GENERATE_IMAGE_BUDGET_MS,
  ffmpeg: MERGE_VIDEOS_BUDGET_MS,
};

/**
 * The task's `run` body, exported directly so it can be invoked in tests
 * without a live Trigger.dev runtime (mirrors src/trigger/turn.ts's
 * `executeAgentTurn` pattern).
 */
export async function executeMediaTool(
  payload: MediaToolTaskPayload,
  { signal: outerSignal }: { signal: AbortSignal },
): Promise<MediaToolTaskResult> {
  const { toolInvocationId } = payload;
  const startedAt = Date.now();

  const invocation = await prisma.toolInvocation.findUniqueOrThrow({
    where: { id: toolInvocationId },
    include: { agentRun: { include: { chat: true } } },
  });

  // Terminal re-entry short-circuit (Trigger.dev retry, duplicate
  // triggerAndWait) — never re-execute an already-settled row; report its
  // already-settled outcome instead.
  if (invocation.status === "COMPLETED" || invocation.status === "FAILED" || invocation.status === "CANCELLED") {
    const resultUrls = (invocation.resultUrls as string[] | null) ?? [];
    const creditUsedApp = invocation.creditUsed === null ? 0 : Number(invocation.creditUsed);
    const durationMs = invocation.durationMs ?? undefined;
    if (invocation.status === "COMPLETED") {
      return { status: "COMPLETED", resultUrls, creditUsedApp, durationMs };
    }
    return {
      status: "FAILED",
      resultUrls,
      creditUsedApp,
      errorCode: invocation.errorCode ?? "unknown",
      errorMessage: invocation.errorMessage ?? "The tool run already ended.",
      durationMs,
    };
  }

  const tool = getToolDefinition(invocation.name);
  // Local tools run in-process in turn.ts and never get a ToolInvocation row,
  // so one reaching this dispatch task is as unrunnable as an unregistered
  // name.
  if (!tool || tool.kind === "local") {
    const errorMessage = `Tool "${invocation.name}" is not registered.`;
    const durationMs = Date.now() - startedAt;
    await markToolFailed({ toolInvocationId, errorCode: "unregistered_tool", errorMessage, durationMs });
    return { status: "FAILED", resultUrls: [], creditUsedApp: 0, errorCode: "unregistered_tool", errorMessage, durationMs };
  }

  const becameRunning = await markToolRunning(toolInvocationId);
  if (!becameRunning) {
    const settled = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: toolInvocationId } });
    if (settled.status === "COMPLETED" || settled.status === "FAILED" || settled.status === "CANCELLED") {
      const resultUrls = (settled.resultUrls as string[] | null) ?? [];
      const creditUsedApp = settled.creditUsed === null ? 0 : Number(settled.creditUsed);
      const durationMs = settled.durationMs ?? Date.now() - startedAt;
      if (settled.status === "COMPLETED") {
        return { status: "COMPLETED", resultUrls, creditUsedApp, durationMs };
      }
      return {
        status: "FAILED",
        resultUrls,
        creditUsedApp,
        errorCode: settled.errorCode ?? "unknown",
        errorMessage: settled.errorMessage ?? "The tool run already ended.",
        durationMs,
      };
    }
    // Still RUNNING (not DISPATCHING, not terminal) — a prior attempt died
    // mid-execute. Fail closed rather than re-executing: the engine's own
    // side effects from that prior attempt are not known to be safe to redo.
    const errorMessage = "The tool run was interrupted and did not finish.";
    const durationMs = Date.now() - startedAt;
    await markToolFailed({ toolInvocationId, errorCode: "interrupted", errorMessage, durationMs });
    return { status: "FAILED", resultUrls: [], creditUsedApp: 0, errorCode: "interrupted", errorMessage, durationMs };
  }

  // Re-reads and reports whatever the row's own terminal state already is —
  // used whenever a mark* call below returns false, meaning some other
  // writer (most likely the orphan sweep, racing a slow-but-legitimate run)
  // already settled the row first. Trusting this task's own in-memory
  // `result` in that case would report an outcome (e.g. COMPLETED +
  // captured credit) that contradicts the durable row a reload reads.
  async function readSettledResult(fallbackDurationMs: number): Promise<MediaToolTaskResult> {
    const settled = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: toolInvocationId } });
    const resultUrls = (settled.resultUrls as string[] | null) ?? [];
    const creditUsedApp = settled.creditUsed === null ? 0 : Number(settled.creditUsed);
    const durationMs = settled.durationMs ?? fallbackDurationMs;
    if (settled.status === "COMPLETED") {
      return { status: "COMPLETED", resultUrls, creditUsedApp, durationMs };
    }
    return {
      status: "FAILED",
      resultUrls,
      creditUsedApp,
      errorCode: settled.errorCode ?? "unknown",
      errorMessage: settled.errorMessage ?? "The tool run already ended.",
      durationMs,
    };
  }

  // Declared outside the try so a throw from mkdtemp itself still lands in
  // the catch/finally below (marks the row FAILED instead of leaving it
  // stuck RUNNING with its credit hold open until the orphan sweep) — the
  // finally only rm's it once it's actually been created.
  let workDir: string | undefined;
  // Phase 6 review finding: a flat per-engine budget starved generate_image's
  // n>1 case, which makes N sequential provider calls inside one execute()
  // — aborting a request still making legitimate progress. estimateBudgetMs
  // lets a tool scale its own budget (e.g. by n); always capped at
  // MEDIA_TOOL_EXEC_DEADLINE_MS, the whole-execute() ceiling every tool
  // shares regardless of engine.
  const perEngineBudgetMs = Math.min(
    tool.estimateBudgetMs?.(invocation.input as never) ?? ENGINE_BUDGET_MS[tool.engine],
    MEDIA_TOOL_EXEC_DEADLINE_MS,
  );
  const engineSignal = AbortSignal.any([outerSignal, AbortSignal.timeout(perEngineBudgetMs)]);

  try {
    workDir = await mkdtemp(join(tmpdir(), `media-${toolInvocationId}-`));
    const result = await tool.execute(invocation.input as never, {
      toolInvocationId,
      agentRunId: invocation.agentRunId,
      ownerId: invocation.agentRun.chat.ownerId,
      workDir,
      signal: engineSignal,
    });

    // Artifact settlement — branch by kind. The three real adapters each
    // only ever produce one kind (crop_image/merge_videos: one artifact
    // each; generate_image: 1-4 `bytes` artifacts) — a mixed url+bytes/file
    // result in the same MediaToolResult is type-legal but never actually
    // produced by any of them today; handled below anyway (merged into one
    // settlement call) since MediaToolResult's own type allows it.
    const urlArtifacts = result.artifacts.filter((a): a is Extract<MediaArtifact, { kind: "url" }> => a.kind === "url");
    const uploadArtifacts = result.artifacts.filter((a) => a.kind === "bytes" || a.kind === "file");

    let resultUrls: string[] = [];
    let sourceUrls: string[] = [];
    let assetIngestStatus: "INGESTED" | "FAILED" | "SKIPPED" = "SKIPPED";
    let assemblyId: string | null = null;

    if (urlArtifacts.length > 0) {
      // ingestGeneratedAssets never throws — falls back to the raw URLs on
      // any Transloadit failure, unchanged from its existing behavior.
      const ingestResult = await ingestGeneratedAssets(
        urlArtifacts.map((a) => a.url),
        { ownerId: invocation.agentRun.chat.ownerId, assetId: toolInvocationId },
      );
      resultUrls = resultUrls.concat(ingestResult.resultUrls);
      sourceUrls = sourceUrls.concat(ingestResult.sourceUrls);
      assetIngestStatus = ingestResult.ingestStatus === "SKIPPED" ? assetIngestStatus : ingestResult.ingestStatus;
      assemblyId = assemblyId ?? ingestResult.assemblyId;
    }

    if (uploadArtifacts.length > 0) {
      // uploadGeneratedArtifacts THROWS on any failure (Task 3.1's chosen
      // convention — there is no raw-URL fallback for locally-produced
      // bytes, since ctx.workDir is deleted in `finally` below). A throw
      // here is caught by the outer catch and settles the invocation
      // FAILED with errorCode "asset_upload_failed" — never
      // COMPLETED-with-no-result.
      try {
        const uploadResult = await uploadGeneratedArtifacts(
          uploadArtifacts,
          { ownerId: invocation.agentRun.chat.ownerId, assetId: toolInvocationId },
          outerSignal,
        );
        resultUrls = resultUrls.concat(uploadResult.resultUrls);
        sourceUrls = sourceUrls.concat(uploadResult.sourceUrls);
        assetIngestStatus = "INGESTED";
        assemblyId = assemblyId ?? uploadResult.assemblyId;
      } catch (uploadError) {
        const errorMessage = "The generated file could not be saved. Please try again.";
        const durationMs = Date.now() - startedAt;
        // No creditUsedApp here, matching every other FAILED path in this
        // file (00-master-spec.md §11: capture nothing on any failure
        // path). This branch used to fall back to the pre-dispatch
        // estimate, which persisted a non-zero creditUsed on a FAILED row
        // and caused turn.ts to capture it — fixed; see turn.ts's capture
        // gate for the other half of this invariant.
        const settledHere = await markToolFailed({
          toolInvocationId,
          errorCode: "asset_upload_failed",
          errorMessage,
          durationMs,
        });
        console.error(`[media-tool] uploadGeneratedArtifacts failed for invocation ${toolInvocationId}`, uploadError);
        if (!settledHere) return readSettledResult(durationMs);
        return {
          status: "FAILED",
          resultUrls: [],
          creditUsedApp: 0,
          errorCode: "asset_upload_failed",
          errorMessage,
          durationMs,
        };
      }
    }

    // Credit settlement: an explicit, deliberate decision (plan B2 step 6)
    // — settle at the adapter's own reported cost when it reports one,
    // otherwise settle at the fixed pre-dispatch estimate rather than 0.
    // Settling at 0 would make every capture a no-op and leave the
    // reserve/capture/release credit-ledger invariant untestable; none of
    // the three real adapters currently report creditUsedApp, so this
    // estimate fallback is the live path today, not a theoretical one.
    const creditUsedApp = result.creditUsedApp ?? Number(invocation.creditEstimate ?? 0);
    const durationMs = Date.now() - startedAt;
    const settledHere = await markToolCompleted({
      toolInvocationId,
      resultUrls,
      creditUsedApp,
      durationMs,
      sourceUrls,
      assetIngestStatus,
      assemblyId,
    });
    if (!settledHere) return readSettledResult(durationMs);
    return { status: "COMPLETED", resultUrls, creditUsedApp, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    // Distinguish "cancelled by the outer task's own signal" (user Stop)
    // from "this engine's own composed budget expired" — checking the
    // OUTER signal specifically, not the composed engineSignal, which is
    // aborted in both cases.
    if (outerSignal.aborted) {
      const settledHere = await markToolCancelled({ toolInvocationId, durationMs });
      if (!settledHere) return readSettledResult(durationMs);
      const errorMessage = "The tool run was cancelled.";
      return { status: "FAILED", resultUrls: [], creditUsedApp: 0, errorCode: "cancelled", errorMessage, durationMs };
    }
    if (engineSignal.aborted) {
      const errorMessage = "The tool did not finish within the expected time.";
      const settledHere = await markToolFailed({ toolInvocationId, errorCode: "timeout", errorMessage, durationMs });
      if (!settledHere) return readSettledResult(durationMs);
      return { status: "FAILED", resultUrls: [], creditUsedApp: 0, errorCode: "timeout", errorMessage, durationMs };
    }

    const classified = classifyMediaToolError(tool.engine, err);
    const settledHere = await markToolFailed({
      toolInvocationId,
      errorCode: classified.errorCode,
      errorMessage: classified.userMessage,
      durationMs,
    });
    console.error(`[media-tool] execute threw for invocation ${toolInvocationId}`, err);
    if (!settledHere) return readSettledResult(durationMs);
    return {
      status: "FAILED",
      resultUrls: [],
      creditUsedApp: 0,
      errorCode: classified.errorCode,
      errorMessage: classified.userMessage,
      durationMs,
    };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const mediaTool = task({
  id: "media-tool",
  // Per-user bound, not global: every trigger site passes
  // `concurrencyKey: userId`, which forks this queue per user
  // (src/lib/config.ts documents the rationale and SDK verification).
  queue: { name: "media-tool", concurrencyLimit: MEDIA_TOOL_QUEUE_CONCURRENCY },
  retry: { maxAttempts: 1 },
  machine: "small-2x",
  maxDuration: MEDIA_TOOL_TASK_MAX_DURATION_S,
  run: executeMediaTool,
});
