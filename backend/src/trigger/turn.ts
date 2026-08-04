/**
 * The one-parent-task-per-turn Trigger.dev task (00-master-spec.md §5/§8,
 * S2-streaming-turn.md). Orchestrates: restore conversation context ->
 * run the provider-neutral OpenRouter loop -> stream + durably persist
 * ordered content blocks (text interleaved with tool_use/tool_result) as
 * they arrive -> finalize to a terminal, explainable state.
 *
 * S3 additions: builds the `onToolCalls` executor the loop invokes once
 * per round of accumulated tool calls. Per call: creates the DISPATCHING
 * ToolInvocation row, grows the credit hold (D2), triggers the media-tool
 * child task (src/trigger/tool.ts) and waits for it, then captures credit
 * and writes the `tool_result` block — capture and the block write happen
 * in the same transaction (S3 plan §5.3) so settlement and persistence
 * cannot partially apply.
 *
 * Stream index space: one counter (`streamIndex`), owned entirely by this
 * file, assigns every `write()` call's `index` — text delta or tool status
 * transition alike (D1: "one stream, one index space" — a client verifies
 * no gap/duplicate). `persistNow()` always durably checkpoints at whatever
 * `streamIndex` currently is, so every `write()` is immediately followed by
 * a checkpoint at the *same* index — no index is ever sent to a client
 * without a matching durable checkpoint, and no checkpoint ever invents an
 * index nothing was written at.
 *
 * Terminal-state ownership (S2 implementation plan §F, unchanged by S3):
 *   - `run()`'s own explicit return path finalizes `completed` or `failed`
 *     for every LoopResult outcome the loop itself reports (no exception
 *     involved — these are our own domain-defined terminal states).
 *   - `onCancel` is the ONLY place that finalizes `cancelled` — it fires
 *     when `runs.cancel()` aborts the shared `signal`, which in turn aborts
 *     the in-flight OpenRouter fetch or media-tool execution and makes `run()` throw;
 *     Trigger.dev routes that abort to `onCancel`, not to a retry/
 *     onFailure, because it initiated the cancellation itself. Any tool
 *     whose result already landed keeps its capture; any tool still
 *     in-flight is left for the (unchanged) hold-release to settle as
 *     uncaptured (S3 plan §5.5 / D4).
 *   - `onFailure` fires only after retries are exhausted for a genuine
 *     uncaught exception (bug, persistence race, network failure across
 *     every attempt) — finalizes `failed` with a generic explainable
 *     message, never touching already-persisted blocks.
 *   - CRASHED/SYSTEM_FAILURE/TIMED_OUT/EXPIRED fire neither hook — the lazy
 *     reconciler (src/services/runs.ts, wired in step 7) is the backstop.
 */
import { task, wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";
import { runAgentLoop, type LoopResult, type ResolvedToolCall, type ToolExecutionResult } from "@/server/agent/loop";
import { buildConversationMessages } from "@/server/agent/conversation";
import { buildSystemPromptContent } from "@/server/agent/system-prompt";
import {
  createAssistantMessage,
  markRunning,
  reclaimRunningForRetry,
  persistBlocks,
  recordRoundUsage,
  finalizeCompleted,
  finalizeFailed,
  finalizeCancelled,
} from "@/server/agent/persist";
import { assistantStream } from "@/trigger/streams";
import {
  STREAM_CHECKPOINT_EVERY_N_DELTAS,
  STREAM_CHECKPOINT_INTERVAL_MS,
  AGENT_TURN_MAX_DURATION_S,
  AGENT_TURN_QUEUE_CONCURRENCY,
  APPROVAL_CREDIT_THRESHOLD,
  WAITPOINT_TIMEOUT_MS,
} from "@/lib/config";
import { getToolDefinition, listToolSpecs } from "@/server/tools/registry";
import { mediaTool, type MediaToolTaskResult } from "@/trigger/tool";
import { reserveAdditional, captureForTool, InsufficientCreditsError } from "@/services/credits";
import { markToolFailed } from "@/services/tool-invocations";
import { createWaitpoint, toWaitpointDTO } from "@/services/waitpoints";
import { ASK_USER_TOOL_NAME, type AskUserInput } from "@/contracts/tools";
import type { ContentBlock } from "@/contracts/common";
import type { TurnStreamPart } from "@/contracts/runs";
import type { Prisma } from "@/generated/prisma/client";

export interface AgentTurnPayload {
  runId: string;
  chatId: string;
  userMessageId: string;
  userId: string;
  requestedModel: string;
}

function outcomeToError(result: LoopResult): { errorCode: string; errorMessage: string } {
  switch (result.outcome) {
    case "stream_error":
      return { errorCode: result.errorType ?? "stream_error", errorMessage: result.userMessage ?? "The AI response could not be completed." };
    case "truncated":
      return { errorCode: "truncated", errorMessage: "The response was interrupted unexpectedly. The partial response above was preserved." };
    case "empty_stream":
      return { errorCode: "empty_stream", errorMessage: "The AI provider returned no response. Please try again." };
    case "unsupported_tool":
    case "malformed_tool_arguments":
    case "max_turns_exceeded":
      return { errorCode: result.outcome, errorMessage: result.userMessage ?? "The AI response could not be completed." };
    default:
      return { errorCode: "unknown", errorMessage: "The AI response could not be completed." };
  }
}

/**
 * Ordered content-block assembler. Text deltas append to the trailing open
 * text block; a tool call closes it (the block is already terminal — no
 * explicit "close" needed) and pushes `tool_use` then `tool_result`; the
 * next text delta after that opens a fresh trailing text block.
 */
function createBlockAssembler() {
  const blocks: ContentBlock[] = [{ type: "text", text: "" }];
  return {
    blocks,
    appendTextDelta(delta: string) {
      const last = blocks[blocks.length - 1];
      if (last.type === "text") {
        last.text += delta;
      } else {
        blocks.push({ type: "text", text: delta });
      }
    },
    // Mirrors appendTextDelta exactly, but for `reasoning` blocks — called
    // chronologically as deltas arrive, so a reasoning block that precedes a
    // tool call in real time naturally lands before that tool_use block in
    // `blocks` too (assignment §5 ordering requirement).
    appendReasoningDelta(delta: string) {
      const last = blocks[blocks.length - 1];
      if (last.type === "reasoning") {
        last.text += delta;
      } else {
        blocks.push({ type: "reasoning", text: delta });
      }
    },
    appendBlock(block: ContentBlock) {
      blocks.push(block);
    },
  };
}

interface BuildExecutorContext {
  runId: string;
  chatId: string;
  userId: string;
  /** The Trigger.dev run id (`ctx.run.id`) — this turn's trace id (assignment §11). */
  traceId: string;
  write: (part: TurnStreamPart) => void;
  nextIndex: () => number;
  persistNow: () => Promise<boolean>;
  assembler: ReturnType<typeof createBlockAssembler>;
}

/**
 * S4 — URL allowlist at tool dispatch (S4 implementation plan §4): a model
 * must only pass URLs this chat actually owns into a URL-typed tool
 * argument (crop_image.image_url, gpt_image_2.images, merge_videos.
 * video_urls) — never an arbitrary/exfiltration URL the model hallucinated
 * or copied from elsewhere. Owned = this chat's own READY user Attachments,
 * this chat's own prior ToolInvocation outputs (resultUrls/sourceUrls) so
 * chained tool calls (upload -> edit -> crop) keep working, plus any
 * http(s) URL the human themselves typed/pasted into one of their own
 * `user`-role messages in this chat — trusted the same way an upload is
 * trusted, since it's the account holder's own input, not a URL the model
 * invented. Never extracted from `assistant`-role text, which would let the
 * model launder an arbitrary URL through its own visible reply first.
 */
const HTTP_URL_RE = /https?:\/\/[^\s)"'<>]+/g;

export async function getAllowedAssetUrls(chatId: string): Promise<Set<string>> {
  const [attachments, invocations, userMessages] = await Promise.all([
    prisma.attachment.findMany({ where: { chatId, status: "READY" }, select: { resultUrl: true } }),
    prisma.toolInvocation.findMany({ where: { agentRun: { chatId } }, select: { resultUrls: true, sourceUrls: true } }),
    prisma.message.findMany({ where: { chatId, role: "user" }, select: { content: true } }),
  ]);
  const urls = new Set<string>();
  for (const attachment of attachments) if (attachment.resultUrl) urls.add(attachment.resultUrl);
  for (const invocation of invocations) {
    for (const list of [invocation.resultUrls, invocation.sourceUrls]) {
      if (Array.isArray(list)) {
        for (const url of list) if (typeof url === "string") urls.add(url);
      }
    }
  }
  for (const message of userMessages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        const text = block.text;
        if (typeof text === "string") {
          for (const match of text.matchAll(HTTP_URL_RE)) urls.add(match[0]);
        }
      }
    }
  }
  return urls;
}

export function extractCandidateUrls(input: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) {
      urls.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && /^https?:\/\//.test(item)) urls.push(item);
    }
  }
  return urls;
}

/**
 * Builds the loop's `onToolCalls` executor (assignment's "Core Concepts":
 * tools are isolated — orchestration owns side effects and persistence).
 *
 * Independent tool dispatches now run in parallel (assignment §7:
 * "Independent tool calls may run in parallel, but results, charges, and
 * message ordering stay deterministic"), while everything ordering- and
 * admission-sensitive stays strictly sequential, in model-emitted order:
 *
 *   - Validation, the URL allowlist check, ToolInvocation row creation, the
 *     `tool_use` block append, the DISPATCHING stream write, and —
 *     crucially — the credit *reservation* (`reserveAdditional`) all still
 *     happen one call at a time, in original order, exactly as before. This
 *     is what keeps mid-turn credit exhaustion deterministic: which call(s)
 *     get admitted when headroom runs out depends only on model-emitted
 *     order, never on which tool's network round trip happens to finish
 *     first.
 *   - Only the slow part — `mediaTool.triggerAndWait` (the actual media-tool
 *     execution) and its resulting `captureForTool` — is deferred
 *     into a batch and awaited concurrently via `Promise.allSettled` once a
 *     call's reservation has already succeeded. `reserveAdditional`/
 *     `captureForTool` are each their own atomic, row-locked (`FOR UPDATE`)
 *     transaction (src/services/credits.ts) — safe to issue concurrently
 *     against the same CreditHold row with no read-then-write race, since
 *     admission for the parallelized calls was already decided serially
 *     above.
 *   - `Promise.allSettled` (not `Promise.all`) — one tool's dispatch
 *     throwing can never cancel or orphan sibling dispatches already
 *     in-flight; each batched dispatch also has its own internal try/catch
 *     so a thrown error still resolves to a normal FAILED outcome rather
 *     than an unhandled rejection.
 *   - Once a batch settles, its `tool_result` blocks/stream writes/persist
 *     checkpoints are still applied strictly in original call order — never
 *     completion-race order — so persisted message content is byte-for-byte
 *     reproducible regardless of which tool call actually finished first.
 *   - A batch is always flushed (awaited to completion) before any call
 *     that suspends the whole Trigger.dev run (`ask_user`, or a
 *     credit-approval waitpoint) — those inherently serialize the turn
 *     around a human response, so nothing is gained by leaving a prior
 *     batch in flight across that boundary, and flushing first preserves
 *     the exact pre-parallel relative ordering across such a boundary.
 */
function buildToolExecutor(ctx: BuildExecutorContext) {
  const { runId, chatId, userId, traceId, write, nextIndex, persistNow, assembler } = ctx;

  // Computed at most once per turn's tool-call batch, not once per call —
  // every call in the same round shares the same owned-URL set.
  let allowedUrlsPromise: Promise<Set<string>> | null = null;
  function allowedUrls(): Promise<Set<string>> {
    if (!allowedUrlsPromise) allowedUrlsPromise = getAllowedAssetUrls(chatId);
    return allowedUrlsPromise;
  }

  // Every checkpoint in this executor must stop the tool loop the same way
  // onDelta's call sites already do (audit item 25): once the run has been
  // finalized elsewhere (cancel/crash), a bare `await persistNow()` with the
  // returned `stillActive` ignored let the loop carry on creating
  // ToolInvocation rows, growing credit holds, dispatching tools, and
  // capturing credit for a run that's already terminal.
  async function persistOrStop(): Promise<void> {
    const stillActive = await persistNow();
    if (!stillActive) throw new Error("Run is no longer active; another process finalized it.");
  }

  async function failWithoutInvocation(
    callId: string,
    name: string,
    errorMessage: string,
    input: Record<string, unknown> = {},
  ): Promise<ToolExecutionResult> {
    // No ToolInvocation row exists (unregistered tool / invalid input, or a
    // local tool, which never creates one) — nothing to dispatch, so there's
    // no toolInvocationId to put on a "tool" stream part (the contract
    // requires one). The tool_use/tool_result blocks alone still make this
    // explainable from the UI.
    assembler.appendBlock({ type: "tool_use", id: callId, name, input });
    // `status` must be set explicitly — an absent status is treated as
    // "still running" by the frontend's ToolCard (defaults to the running
    // set when status is undefined), which otherwise left these permanently
    // spinning even though the call had already failed.
    assembler.appendBlock({
      type: "tool_result",
      toolUseId: callId,
      output: { error: errorMessage },
      isError: true,
      name,
      status: "FAILED",
      errorMessage,
    });
    await persistOrStop();
    return { id: callId, output: { status: "failed", error: errorMessage }, isError: true };
  }

  // One entry per call whose credit reservation already succeeded and whose
  // (slow) media-tool dispatch is queued to run concurrently with any other
  // reserved call in the same round — see the executor's own doc comment
  // above for the full concurrency-safety argument.
  interface PendingDispatch {
    callIndex: number;
    call: ResolvedToolCall;
    toolName: string;
    invocationId: string;
    invocationCreatedAt: Date;
  }

  type DispatchOutcome =
    | { kind: "task_failed"; errorMessage: string; durationMs: number }
    | { kind: "success"; output: MediaToolTaskResult };

  // Never throws — every failure mode (a reported `{ ok: false }`, or the
  // triggerAndWait/capture call itself throwing) is converted into a
  // DispatchOutcome so Promise.allSettled's rejection branch is only ever a
  // defensive backstop, not the normal failure path.
  async function dispatchOne(runId: string, userId: string, item: PendingDispatch): Promise<DispatchOutcome> {
    try {
      const taskResult = await mediaTool.triggerAndWait(
        { toolInvocationId: item.invocationId },
        { idempotencyKey: item.invocationId, concurrencyKey: userId },
      );

      if (!taskResult.ok) {
        const errorMessage = "The tool could not be completed.";
        const durationMs = Date.now() - item.invocationCreatedAt.getTime();
        await markToolFailed({ toolInvocationId: item.invocationId, errorCode: "tool_task_failed", errorMessage, durationMs });
        return { kind: "task_failed", errorMessage, durationMs };
      }

      const output = taskResult.output;
      // Capture is always at the tool's reported creditUsed, never the
      // pre-dispatch estimate (D2 / 00-master-spec.md §4 scenario 1) —
      // gated on COMPLETED, not merely a positive amount, per
      // 00-master-spec.md §11: "capture nothing on any failure path." Every
      // FAILED tool.ts path reports creditUsedApp: 0 today, but the status
      // check is the invariant's real home — it must hold even if a future
      // adapter reports a positive cost on a failure. Row-locked
      // (FOR UPDATE) inside its own transaction — safe to run concurrently
      // with a sibling call's captureForTool against the same CreditHold row.
      if (output.status === "COMPLETED" && output.creditUsedApp > 0) {
        await prisma.$transaction((tx) =>
          captureForTool(tx, { runId, userId, toolInvocationId: item.invocationId, amount: output.creditUsedApp }),
        );
      }
      return { kind: "success", output };
    } catch {
      // Defensive: an unexpected throw here (rather than a reported
      // `{ ok: false }`) must still resolve to a normal FAILED outcome, not
      // propagate and risk cancelling/orphaning sibling dispatches.
      const errorMessage = "The tool could not be completed.";
      const durationMs = Date.now() - item.invocationCreatedAt.getTime();
      await markToolFailed({ toolInvocationId: item.invocationId, errorCode: "tool_task_failed", errorMessage, durationMs }).catch(() => {});
      return { kind: "task_failed", errorMessage, durationMs };
    }
  }

  return async (calls: ResolvedToolCall[], turnIndex: number): Promise<ToolExecutionResult[]> => {
    // Reset at the start of each round: this executor is invoked once per
    // tool-call round within the same turn (chained upload -> edit -> crop),
    // and the previous round's memoized set wouldn't include outputs that
    // round just produced.
    allowedUrlsPromise = null;
    const results: ToolExecutionResult[] = new Array(calls.length);
    let pending: PendingDispatch[] = [];

    // Awaits every queued dispatch concurrently, then applies each one's
    // tool_result block/stream write/persist checkpoint strictly in
    // original call order — never completion-race order — so persisted
    // message content stays deterministic regardless of which tool call
    // actually finished first.
    async function flushPending(): Promise<void> {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const settled = await Promise.allSettled(batch.map((item) => dispatchOne(runId, userId, item)));

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const outcome = settled[i];
        // dispatchOne never itself throws — a `rejected` entry here would
        // mean a genuine bug, not a tool failure, so it's surfaced rather
        // than silently swallowed.
        if (outcome.status === "rejected") throw outcome.reason;
        const result = outcome.value;
        const call = item.call;

        if (result.kind === "task_failed") {
          assembler.appendBlock({
            type: "tool_result",
            toolUseId: call.id,
            output: { error: result.errorMessage },
            isError: true,
            toolInvocationId: item.invocationId,
            name: item.toolName,
            status: "FAILED",
            durationMs: result.durationMs,
            errorMessage: result.errorMessage,
          });
          write({
            index: nextIndex(),
            type: "tool",
            toolInvocationId: item.invocationId,
            name: item.toolName,
            status: "FAILED",
            errorMessage: result.errorMessage,
          });
          await persistOrStop();
          results[item.callIndex] = { id: call.id, output: { status: "failed", error: result.errorMessage }, isError: true };
          continue;
        }

        const output = result.output;
        const isError = output.status !== "COMPLETED";
        assembler.appendBlock({
          type: "tool_result",
          toolUseId: call.id,
          output: isError ? { error: output.errorMessage } : { resultUrls: output.resultUrls },
          isError,
          toolInvocationId: item.invocationId,
          name: item.toolName,
          status: output.status,
          creditUsed: output.creditUsedApp,
          resultUrls: output.resultUrls.length > 0 ? output.resultUrls : undefined,
          durationMs: output.durationMs,
          errorMessage: output.errorMessage,
        });
        write({
          index: nextIndex(),
          type: "tool",
          toolInvocationId: item.invocationId,
          name: item.toolName,
          status: output.status,
          creditUsed: output.creditUsedApp,
          resultUrls: output.resultUrls,
          errorMessage: output.errorMessage,
        });
        await persistOrStop();
        results[item.callIndex] = {
          id: call.id,
          output: isError ? { status: "failed", error: output.errorMessage } : { status: "completed", resultUrls: output.resultUrls },
          isError,
        };
      }
    }

    for (const [callIndex, call] of calls.entries()) {
      const tool = getToolDefinition(call.name);
      if (!tool) {
        results[callIndex] = await failWithoutInvocation(call.id, call.name, `Tool "${call.name}" is not registered.`);
        continue;
      }

      const parsedInput = tool.inputSchema.safeParse(call.args);
      if (!parsedInput.success) {
        results[callIndex] = await failWithoutInvocation(
          call.id,
          tool.name,
          "The tool call's arguments did not match its expected shape.",
        );
        continue;
      }
      const sanitizedInput = parsedInput.data as Record<string, unknown>;

      // Local tools (skills) are free, synchronous, in-process guidance
      // reads: no URL allowlist (they name skills, not assets), no
      // ToolInvocation row, no credit hold, no media-tool child task
      // (S5-skills.md §B). Everything below this branch is media-tool-only.
      // Still emitted as a "tool" stream part (using call.id in place of a
      // real toolInvocationId — the contract only requires a stable string,
      // and no consumer looks it up against the ToolInvocation table for
      // local tools) so the live-streaming UI sees the skill step as it
      // happens, not only after the run settles and re-renders from the
      // persisted content blocks.
      // S6 (§6.2a/§7.1): ask_user is `kind: "local"` for model-facing
      // discovery only — its dispatch is not the synchronous local-tool
      // path below, so it must be intercepted here first, or it would fall
      // into that branch and call the handler that deliberately throws.
      if (call.name === ASK_USER_TOOL_NAME) {
        // ask_user suspends the whole Trigger.dev run on wait.forToken()
        // below — settle any already-queued parallel dispatches first so
        // their side effects land before the suspend, preserving the exact
        // relative ordering the old fully-sequential code had across this
        // boundary.
        await flushPending();
        write({ index: nextIndex(), type: "tool", toolInvocationId: call.id, name: tool.name, status: "DISPATCHING" });

        const askUserInput = parsedInput.data as AskUserInput;
        const token = await wait.createToken({
          timeout: new Date(Date.now() + WAITPOINT_TIMEOUT_MS),
          idempotencyKey: `waitpoint:${runId}:${call.id}`,
        });

        const created = await prisma.$transaction((tx) =>
          createWaitpoint(tx, {
            runId,
            kind: "CLARIFICATION",
            requestPayload: { question: askUserInput.question, options: askUserInput.options },
            triggerTokenId: token.id,
            expiresAt: new Date(Date.now() + WAITPOINT_TIMEOUT_MS),
          }),
        );
        const waitpointRow = await prisma.waitpoint.findUniqueOrThrow({ where: { id: created.id } });
        write({ index: nextIndex(), type: "waitpoint", waitpoint: toWaitpointDTO(waitpointRow) });
        await persistOrStop();

        await wait.forToken<unknown>(token.id);

        const runAfterWait = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
        if (runAfterWait.status !== "waiting" && runAfterWait.status !== "running") {
          throw new Error("Run is no longer active; another process finalized it.");
        }
        await prisma.agentRun.updateMany({ where: { id: runId, status: "waiting" }, data: { status: "running" } });

        // Never trust the resume payload directly — re-read the
        // waitpoint's own resolvedPayload from the DB, same reasoning as
        // the CREDIT_APPROVAL gate above.
        const resolved = await prisma.waitpoint.findUniqueOrThrow({ where: { id: created.id } });
        const answer = (resolved.resolvedPayload as { answer?: string } | null)?.answer ?? "";

        assembler.appendBlock({ type: "tool_use", id: call.id, name: tool.name, input: sanitizedInput });
        assembler.appendBlock({
          type: "tool_result",
          toolUseId: call.id,
          output: { answer },
          isError: false,
          name: tool.name,
          status: "COMPLETED",
        });
        write({ index: nextIndex(), type: "tool", toolInvocationId: call.id, name: tool.name, status: "COMPLETED" });
        await persistOrStop();
        results[callIndex] = { id: call.id, output: { status: "completed", answer }, isError: false };
        continue;
      }

      if (tool.kind === "local") {
        write({ index: nextIndex(), type: "tool", toolInvocationId: call.id, name: tool.name, status: "DISPATCHING" });
        const output = await tool.handler(parsedInput.data, { agentRunId: runId });
        if ("error" in output && "code" in output) {
          write({ index: nextIndex(), type: "tool", toolInvocationId: call.id, name: tool.name, status: "FAILED", errorMessage: String(output.error) });
          results[callIndex] = await failWithoutInvocation(call.id, tool.name, String(output.error), sanitizedInput);
          continue;
        }
        // Re-validated here even though both handlers self-validate: the
        // registry is the one authoritative validation seam (assignment §2),
        // so a future local tool that forgets to self-validate still can't
        // put an off-contract payload into a persisted block.
        const validated = tool.outputSchema ? tool.outputSchema.safeParse(output) : { success: true as const, data: output };
        if (!validated.success) {
          write({
            index: nextIndex(),
            type: "tool",
            toolInvocationId: call.id,
            name: tool.name,
            status: "FAILED",
            errorMessage: "The tool returned an unexpected result.",
          });
          results[callIndex] = await failWithoutInvocation(
            call.id,
            tool.name,
            "The tool returned an unexpected result.",
            sanitizedInput,
          );
          continue;
        }
        assembler.appendBlock({ type: "tool_use", id: call.id, name: tool.name, input: sanitizedInput });
        assembler.appendBlock({
          type: "tool_result",
          toolUseId: call.id,
          output: validated.data as Record<string, unknown>,
          isError: false,
          name: tool.name,
          status: "COMPLETED",
        });
        write({ index: nextIndex(), type: "tool", toolInvocationId: call.id, name: tool.name, status: "COMPLETED" });
        await persistOrStop();
        results[callIndex] = { id: call.id, output: { status: "completed", ...(validated.data as Record<string, unknown>) }, isError: false };
        continue;
      }

      const candidateUrls = extractCandidateUrls(sanitizedInput);
      if (candidateUrls.length > 0) {
        const allowed = await allowedUrls();
        if (candidateUrls.some((url) => !allowed.has(url))) {
          results[callIndex] = await failWithoutInvocation(
            call.id,
            tool.name,
            "One or more referenced files are not available in this chat.",
          );
          continue;
        }
      }

      const estimate = tool.estimateCredits(parsedInput.data);

      // S6 (.claude/specs/S6-reliability-implementation-plan.md §6.3/§7.1):
      // a pre-dispatch estimate over the threshold suspends the run on a
      // CREDIT_APPROVAL waitpoint instead of dispatching immediately —
      // zero compute burned while idle, since wait.forToken() actually
      // suspends the Trigger.dev run.
      if (estimate > APPROVAL_CREDIT_THRESHOLD) {
        // Same reasoning as the ask_user boundary above — a credit-approval
        // waitpoint also suspends the whole run, so flush before crossing it.
        await flushPending();
        const token = await wait.createToken({
          timeout: new Date(Date.now() + WAITPOINT_TIMEOUT_MS),
          idempotencyKey: `waitpoint:${runId}:${call.id}`,
        });

        const created = await prisma.$transaction((tx) =>
          createWaitpoint(tx, {
            runId,
            kind: "CREDIT_APPROVAL",
            requestPayload: { toolName: tool.name, estimatedCredits: estimate, threshold: APPROVAL_CREDIT_THRESHOLD },
            triggerTokenId: token.id,
            expiresAt: new Date(Date.now() + WAITPOINT_TIMEOUT_MS),
          }),
        );
        const waitpointRow = await prisma.waitpoint.findUniqueOrThrow({ where: { id: created.id } });
        write({ index: nextIndex(), type: "waitpoint", waitpoint: toWaitpointDTO(waitpointRow) });
        await persistOrStop();

        const result = await wait.forToken<unknown>(token.id);

        // Never trust `result.output`/`wait.forToken`'s own resume payload
        // for the approval decision — re-read the DB row directly, both
        // because a timed-out `!result.ok` and a resolved-but-rejected
        // waitpoint must be handled identically, and because the row is the
        // one place `respondToWaitpoint` actually wrote the decision.
        let approved = false;
        if (result.ok) {
          const resolved = await prisma.waitpoint.findUnique({ where: { id: created.id } });
          approved = (resolved?.resolvedPayload as { approved?: boolean } | null)?.approved === true;
        }

        if (!approved) {
          results[callIndex] = await failWithoutInvocation(
            call.id,
            tool.name,
            "The user did not approve this action.",
            sanitizedInput,
          );
          continue;
        }

        // The run may have been cancelled or expired-and-failed by the
        // sweep while suspended — do not proceed with dispatch for a run
        // another process already finalized.
        const runAfterWait = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
        if (runAfterWait.status !== "waiting" && runAfterWait.status !== "running") {
          throw new Error("Run is no longer active; another process finalized it.");
        }
        await prisma.agentRun.updateMany({ where: { id: runId, status: "waiting" }, data: { status: "running" } });
      }

      const invocation = await prisma.toolInvocation.create({
        data: {
          agentRunId: runId,
          turnIndex,
          callIndex,
          toolCallId: call.id,
          name: tool.name,
          // VyomFlow: nodeType's persisted VALUE now comes from tool.name
          // (was the old reference-implementation nodeType string) — the column/DTO field
          // name itself stays "nodeType" (deliberate, see registry.ts's
          // MediaEngine doc comment). Low-risk value-source change for
          // these three real tools: tool.name === the old nodeType string
          // in every case ("crop_image"/"generate_image"/"merge_videos").
          nodeType: tool.name,
          input: sanitizedInput as unknown as Prisma.InputJsonValue,
          status: "DISPATCHING",
          creditEstimate: estimate,
        },
      });

      assembler.appendBlock({
        type: "tool_use",
        id: call.id,
        name: tool.name,
        input: sanitizedInput,
      });
      write({ index: nextIndex(), type: "tool", toolInvocationId: invocation.id, name: tool.name, status: "DISPATCHING" });
      await persistOrStop();

      try {
        await prisma.$transaction((tx) =>
          reserveAdditional(tx, { runId, userId, toolInvocationId: invocation.id, amount: estimate, traceId }),
        );
      } catch (error) {
        if (!(error instanceof InsufficientCreditsError)) throw error;
        const errorMessage = "Not enough credits remain to run this tool.";
        // Fails before the media-tool child task ever runs, so there's no
        // tool.ts-reported durationMs — time-since-dispatch (row creation)
        // is the accurate duration for this path.
        const durationMs = Date.now() - invocation.createdAt.getTime();
        await markToolFailed({ toolInvocationId: invocation.id, errorCode: "insufficient_credits", errorMessage, durationMs });
        assembler.appendBlock({
          type: "tool_result",
          toolUseId: call.id,
          output: { error: errorMessage },
          isError: true,
          toolInvocationId: invocation.id,
          name: tool.name,
          status: "FAILED",
          durationMs,
          errorMessage,
        });
        write({ index: nextIndex(), type: "tool", toolInvocationId: invocation.id, name: tool.name, status: "FAILED", errorMessage });
        await persistOrStop();
        results[callIndex] = { id: call.id, output: { status: "failed", error: errorMessage }, isError: true };
        continue;
      }

      // Reservation succeeded — everything ordering/admission-sensitive for
      // this call is already done, in original call order (validation,
      // ToolInvocation row, tool_use block, DISPATCHING write, reservation
      // itself). Queue the actual (slow) media-tool dispatch to run
      // concurrently with any other reserved call in this round; its
      // tool_result block is appended once the whole batch settles, still
      // in original order (see flushPending above).
      pending.push({
        callIndex,
        call,
        toolName: tool.name,
        invocationId: invocation.id,
        invocationCreatedAt: invocation.createdAt,
      });
    }

    await flushPending();

    return results;
  };
}

/**
 * The task's `run` body, extracted and exported as a plain function so it
 * can be invoked directly in tests (Trigger.dev's `task()` wrapper does not
 * expose its `run` on the returned object — only `trigger`/`triggerAndWait`/
 * etc., which require a live Trigger.dev runtime). Same signature Trigger.dev
 * itself calls it with.
 */
export async function executeAgentTurn(payload: AgentTurnPayload, { ctx, signal }: { ctx: { run: { id: string } }; signal: AbortSignal }) {
  const { runId, chatId, userMessageId, userId, requestedModel } = payload;

  const existing = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!existing) return; // nothing to do — row was never created or was already cleaned up
  if (existing.status !== "queued" && existing.status !== "running") return; // already terminal (cancel/reconciler won the race)

  // Retry-guard (S2-streaming-turn.md's worker-failure requirement, D4):
  // neither OpenRouter nor the media-tool engines offer generation/dispatch resume. If any
  // progress was already durably persisted, this attempt is a retry after
  // an interrupted turn — finalize as failed rather than starting a second,
  // unrelated generation (or re-dispatching an ambiguous tool call) past
  // what's already there.
  if (existing.lastStreamIndex > -1) {
    await finalizeFailed({
      runId,
      chatId,
      traceId: ctx.run.id,
      assistantMessageId: existing.assistantMessageId,
      errorCode: "generation_interrupted",
      errorMessage: "The response was interrupted before it could finish. The partial response above was preserved.",
      fromStatus: existing.status,
    });
    return;
  }

  const claimed =
    existing.status === "queued" ? await markRunning(runId, ctx.run.id) : await reclaimRunningForRetry(runId, ctx.run.id);
  if (!claimed) return; // lost the race — e.g. cancelled while queued, by the cancel route

  // `ctx.run.id` is this turn's traceId everywhere below, so every line the
  // turn emits — its own, persist.ts's finalizers, credits.ts's settlement —
  // correlates to one turn (assignment §11 "Logs").
  log.info("turn.started", { runId, chatId, traceId: ctx.run.id, userId, requestedModel });

  const assistantMessageId = existing.assistantMessageId ?? (await createAssistantMessage(runId, chatId));
  // System message is synthesized fresh here (never persisted) and added
  // after buildConversationMessages's own history cap, so it can never be
  // evicted by that cap — and buildConversationMessages itself stays
  // untouched so its unit tests keep asserting on message[0]/length as-is.
  const messages = [
    { role: "system" as const, content: await buildSystemPromptContent() },
    ...(await buildConversationMessages(chatId, userMessageId)),
  ];

  let result: LoopResult | undefined;
  let streamIndex = -1;
  let lastPersistedIndex = -1;
  let deltasSincePersist = 0;
  let lastPersistAt = Date.now();
  let finalizedElsewhere = false;
  const assembler = createBlockAssembler();

  const nextIndex = () => ++streamIndex;

  await assistantStream.writer({
    execute: async ({ write }) => {
      const persistNow = async (): Promise<boolean> => {
        const stillActive = await persistBlocks({ runId, assistantMessageId, index: streamIndex, blocks: assembler.blocks });
        lastPersistedIndex = streamIndex;
        deltasSincePersist = 0;
        lastPersistAt = Date.now();
        if (!stillActive) finalizedElsewhere = true;
        return stillActive;
      };

      result = await runAgentLoop({
        model: requestedModel,
        messages,
        tools: listToolSpecs(),
        signal,
        onDelta: async (part) => {
          assembler.appendTextDelta(part.delta);
          deltasSincePersist++;
          const index = nextIndex();

          // The very first delta of an attempt always persists immediately,
          // before the realtime write (hardening pass, unchanged from S2):
          // closes the crash-guard gap where a retry's `lastStreamIndex >
          // -1` check never trips because nothing was checkpointed yet.
          if (lastPersistedIndex === -1) {
            const stillActive = await persistNow();
            write({ index, type: "text", channel: "text", delta: part.delta });
            if (!stillActive) throw new Error("Run is no longer active; another process finalized it.");
            return;
          }

          write({ index, type: "text", channel: "text", delta: part.delta });

          const dueForCheckpoint =
            deltasSincePersist >= STREAM_CHECKPOINT_EVERY_N_DELTAS || Date.now() - lastPersistAt >= STREAM_CHECKPOINT_INTERVAL_MS;
          if (!dueForCheckpoint) return;

          const stillActive = await persistNow();
          if (!stillActive) {
            throw new Error("Run is no longer active; another process finalized it.");
          }
        },
        // Mirrors onDelta exactly (same checkpoint/first-persist rules),
        // but appends to the trailing `reasoning` block and streams on the
        // "reasoning" channel instead of "text".
        onReasoningDelta: async (part) => {
          assembler.appendReasoningDelta(part.delta);
          deltasSincePersist++;
          const index = nextIndex();

          if (lastPersistedIndex === -1) {
            const stillActive = await persistNow();
            write({ index, type: "text", channel: "reasoning", delta: part.delta });
            if (!stillActive) throw new Error("Run is no longer active; another process finalized it.");
            return;
          }

          write({ index, type: "text", channel: "reasoning", delta: part.delta });

          const dueForCheckpoint =
            deltasSincePersist >= STREAM_CHECKPOINT_EVERY_N_DELTAS || Date.now() - lastPersistAt >= STREAM_CHECKPOINT_INTERVAL_MS;
          if (!dueForCheckpoint) return;

          const stillActive = await persistNow();
          if (!stillActive) {
            throw new Error("Run is no longer active; another process finalized it.");
          }
        },
        onToolCalls: buildToolExecutor({ runId, chatId, userId, traceId: ctx.run.id, write, nextIndex, persistNow, assembler }),
        onRoundUsage: async ({ turnIndex, usage, resolvedModel, generationId }) => {
          await recordRoundUsage({
            runId,
            userId,
            turnIndex,
            metadata: { resolvedModel, generationId, ...usage } as Prisma.InputJsonValue,
            traceId: ctx.run.id,
          });
        },
      });
    },
  }).waitUntilComplete();

  if (!result) return; // execute threw before assigning — handled by the stillActive guard above

  // Unconditional final checkpoint: the throttle above may have skipped
  // persisting the last few deltas/blocks.
  if (streamIndex > lastPersistedIndex) {
    const stillActive = await persistBlocks({ runId, assistantMessageId, index: streamIndex, blocks: assembler.blocks });
    if (!stillActive) finalizedElsewhere = true;
  }
  if (finalizedElsewhere) return;

  if (result.outcome === "completed") {
    await finalizeCompleted({
      runId,
      chatId,
      traceId: ctx.run.id,
      assistantMessageId,
      blocks: assembler.blocks,
      resolvedModel: result.resolvedModel,
      usage: result.usage,
    });
    return;
  }

  const { errorCode, errorMessage } = outcomeToError(result);
  await finalizeFailed({ runId, chatId, traceId: ctx.run.id, assistantMessageId, errorCode, errorMessage, fromStatus: "running" });
}

export const agentTurn = task({
  id: "agent-turn",
  // Per-user bound, not global: dispatchAgentTurn passes
  // `concurrencyKey: userId`, which forks this queue per user
  // (src/lib/config.ts documents the rationale and SDK verification).
  queue: { name: "agent-turn", concurrencyLimit: AGENT_TURN_QUEUE_CONCURRENCY },
  retry: { maxAttempts: 3 },
  // Must stay strictly greater than the media-tool child task's own
  // maxDuration (audit item 22) — a single slow tool dispatch was
  // previously able to time out the parent turn before the child gave up.
  // Named constant (S6 plan §7.6) so this and trigger.config.ts's global
  // default can never silently drift apart again — both now derive from
  // the same src/lib/config.ts source of truth.
  maxDuration: AGENT_TURN_MAX_DURATION_S,
  run: executeAgentTurn,
  onCancel: async ({ payload }) => {
    const run = await prisma.agentRun.findUnique({ where: { id: payload.runId } });
    // "waiting" included (hardening pass): the cancel route already defers
    // finalization of a cancelled `waiting` run to this hook (it only sets
    // `cancelRequestedAt` for any non-`queued` status), but this guard
    // previously excluded `waiting`, so that finalize never happened and
    // the run stayed stuck. Currently unreachable (nothing sets `waiting`
    // yet — S3), but the cancel route already codes for it as live.
    if (!run || (run.status !== "queued" && run.status !== "running" && run.status !== "waiting")) return;
    await finalizeCancelled({
      runId: run.id,
      chatId: run.chatId,
      assistantMessageId: run.assistantMessageId,
      fromStatus: run.status,
    });
  },
  onFailure: async ({ payload }) => {
    const run = await prisma.agentRun.findUnique({ where: { id: payload.runId } });
    if (!run || (run.status !== "queued" && run.status !== "running" && run.status !== "waiting")) return;
    await finalizeFailed({
      runId: run.id,
      chatId: run.chatId,
      assistantMessageId: run.assistantMessageId,
      errorCode: "retries_exhausted",
      errorMessage: "The response could not be completed after multiple attempts. Please try again.",
      fromStatus: run.status,
    });
  },
});
