/**
 * Durable persistence/finalize service for the agentTurn task
 * (S2-streaming-turn.md, S2 implementation plan §F). Every transition is a
 * conditional UPDATE guarded on the row's *current* status — via
 * `updateMany({ where: { id, status: <expected> } })`, whose `count`
 * tells the caller whether it actually won the transition — so a
 * late-arriving writer (a cancel racing a completion, a duplicate
 * finalize) can never resurrect or double-write a terminal run.
 * Postgres is the durable source of truth; Trigger.dev is execution
 * mechanics only (00-master-spec.md §5).
 */
import { prisma } from "@/lib/db";
import { releaseHold as releaseHoldTx, recordUsage as recordUsageTx } from "@/services/credits";
import { log } from "@/lib/logger";
import { emitWebhookEvent } from "@/server/webhooks/emit";
import { buildAgentStartedPayload, buildAgentCompletedPayload, buildAgentFailedPayload } from "@/server/webhooks/events";
import type { ContentBlock } from "@/contracts/common";
import type { Prisma } from "@/generated/prisma/client";

function textContent(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

/**
 * Resolves the webhook-emission identity (owning user + chat) for a run by
 * its id alone — deliberately not threaded through every finalizer call
 * site's params (several, e.g. src/trigger/sweep.ts's waitpoint-expiry path
 * and src/services/runs.ts's reconciler, never had a userId in scope at
 * all). One extra indexed-by-PK lookup on the (rare, best-effort) webhook
 * path is cheap; requiring every existing call site to thread userId
 * through was not worth the churn. Returns null only if the run itself has
 * vanished (never expected on a row a finalizer just transitioned).
 */
async function ownerAndChatForRun(runId: string): Promise<{ userId: string; chatId: string } | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { chatId: true, chat: { select: { ownerId: true } } },
  });
  return run ? { userId: run.chat.ownerId, chatId: run.chatId } : null;
}

/**
 * Records one OpenRouter round's usage on its own (S3 — cross-spec
 * consistency-gate finding): a multi-turn tool-calling turn re-enters the
 * model once per tool round, and `recordUsage`'s idempotency key is keyed
 * by `turnIndex`, so every round with usage needs its own call, not just
 * the final one folded into `finalizeCompleted`. Standalone (opens its own
 * transaction) since it fires mid-loop, before the turn has a terminal
 * outcome to finalize.
 */
export async function recordRoundUsage(params: {
  runId: string;
  userId: string;
  turnIndex: number;
  metadata: Prisma.InputJsonValue;
  traceId?: string;
}): Promise<void> {
  await prisma.$transaction((tx) => recordUsageTx(tx, params));
}

/**
 * Creates the (initially empty) assistant Message and links it to the run.
 * Called once, before any streaming begins.
 */
export async function createAssistantMessage(runId: string, chatId: string): Promise<string> {
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { chatId, role: "assistant", status: "streaming", content: textContent("") as unknown as Prisma.InputJsonValue },
    });
    await tx.agentRun.update({ where: { id: runId }, data: { assistantMessageId: created.id } });
    return created;
  });
  return message.id;
}

/**
 * queued -> running (conditional). Returns false if another writer already
 * claimed it (e.g. a cancel-while-queued). Emits `agent.started` on a
 * genuine transition only — `reclaimRunningForRetry` below is a crashed
 * *retry* of the same run continuing, not a new start, and never emits.
 */
export async function markRunning(runId: string, triggerRunId: string): Promise<boolean> {
  const { count } = await prisma.agentRun.updateMany({
    where: { id: runId, status: "queued" },
    data: { status: "running", triggerRunId, startedAt: new Date() },
  });
  const started = count > 0;
  if (started) {
    const owner = await ownerAndChatForRun(runId);
    if (owner) {
      await emitWebhookEvent({
        userId: owner.userId,
        eventType: "agent.started",
        payload: buildAgentStartedPayload({ runId, chatId: owner.chatId }),
      });
    }
  }
  return started;
}

/**
 * Re-affirms an already-`running` row for a Trigger.dev retry of a crashed
 * attempt that made zero persisted progress (hardening pass — previously
 * this scenario had no claim path at all: `markRunning` only matches
 * `status: "queued"`, so a retry landing here silently no-op'd, permanently
 * stranding the run in `running` until the 15-minute orphan backstop).
 * Conditional on `lastStreamIndex` still being `-1` — the caller
 * (src/trigger/turn.ts) only reaches this path after confirming that, and
 * Trigger.dev serializes retries of one run (never concurrently executes
 * two attempts of the same run), so this can never race a writer that has
 * already made real progress. Also conditional on `cancelRequestedAt` still
 * being null: the cancel route can set it on a `running` row (S2's
 * `stopping` semantics) without the crashed attempt ever having observed
 * the abort signal, so a retry must not silently resume generation for a
 * run whose cancellation is already pending — that belongs to `onCancel`.
 */
export async function reclaimRunningForRetry(runId: string, triggerRunId: string): Promise<boolean> {
  const { count } = await prisma.agentRun.updateMany({
    where: { id: runId, status: "running", lastStreamIndex: -1, cancelRequestedAt: null },
    data: { triggerRunId, startedAt: new Date() },
  });
  return count > 0;
}

/**
 * Persists one durably-accumulated snapshot of the assistant's ordered
 * content blocks and advances `lastStreamIndex` in the same transaction,
 * guarded on the run still being `running` or `waiting`. Returns false when
 * the guard fails — the caller (the task) must stop emitting further stream
 * parts, since the run was finalized (cancelled/failed) by someone else in
 * the meantime.
 *
 * S3: widened from a single accumulated-text rewrite to the full ordered
 * `ContentBlock[]` (text/tool_use/tool_result interleaved) — the
 * orchestrator (src/trigger/turn.ts) owns block assembly; this function
 * only persists whatever snapshot it's given, unchanged in shape from S2's
 * text-only behavior when no tool blocks exist.
 *
 * S6 (.claude/specs/S6-reliability-implementation-plan.md §6.3/§7.1): the
 * waitpoint gate transitions `AgentRun.status` to `"waiting"` *before* its
 * own checkpoint write (so the newly-created waitpoint's stream part is
 * durably persisted before suspending) — a `status: "running"`-only guard
 * here would reject that legitimate in-flight checkpoint as if the run had
 * already been finalized elsewhere, indistinguishable from the real
 * terminal-race case this guard exists to catch. `"waiting"` is a genuine
 * non-terminal, still-owned-by-this-task state, not a finalized one.
 */
export async function persistBlocks(params: {
  runId: string;
  assistantMessageId: string;
  index: number;
  blocks: ContentBlock[];
}): Promise<boolean> {
  const { runId, assistantMessageId, index, blocks } = params;
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: runId, status: { in: ["running", "waiting"] } },
      data: { lastStreamIndex: index },
    });
    if (count === 0) return false;
    await tx.message.update({
      where: { id: assistantMessageId },
      data: { content: blocks as unknown as Prisma.InputJsonValue },
    });
    return true;
  });
}

/**
 * Correlation IDs threaded in by the caller for the terminal-transition log
 * lines (assignment §11 "Logs"). Optional because some callers — the sweep,
 * `reconcileIfStale` — act on a run they hold only by id and outside any
 * Trigger.dev run context; omitting an unknown field is preferable to
 * inventing one.
 */
interface TraceFields {
  chatId?: string;
  traceId?: string;
}

interface FinalizeCompletedParams extends TraceFields {
  runId: string;
  assistantMessageId: string;
  /** Final ordered content blocks (text/tool_use/tool_result), WITHOUT the trailing usage block — appended here. */
  blocks: ContentBlock[];
  resolvedModel: string | undefined;
  usage: { promptTokens: number; completionTokens: number; costCredits: number } | undefined;
}

/**
 * running -> completed. Appends the usage block and releases whatever
 * remains of the hold (S3: per-round usage is already recorded via
 * `recordRoundUsage` as each OpenRouter round completes — see loop.ts's
 * `onRoundUsage` — so this no longer records usage itself; `usage` here is
 * only for the message's trailing display block).
 */
export async function finalizeCompleted(params: FinalizeCompletedParams): Promise<boolean> {
  const { runId, assistantMessageId, blocks, resolvedModel, usage, chatId, traceId } = params;
  const applied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: runId, status: "running" },
      data: { status: "completed", resolvedModel, finishedAt: new Date() },
    });
    if (count === 0) return false;

    const content: ContentBlock[] = [
      ...blocks,
      ...(usage
        ? ([
            {
              type: "usage" as const,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              model: resolvedModel,
              costCredits: usage.costCredits,
            },
          ] as ContentBlock[])
        : []),
    ];
    await tx.message.update({
      where: { id: assistantMessageId },
      data: { status: "complete", content: content as unknown as Prisma.InputJsonValue },
    });

    await releaseHoldTx(tx, runId, traceId);
    return true;
  });
  // `applied: false` means another writer won the terminal transition
  // first — a race worth seeing in the log, not an error.
  log.info("run.finalized", { runId, chatId, messageId: assistantMessageId, traceId, status: "completed", applied });
  if (applied) {
    const owner = await ownerAndChatForRun(runId);
    if (owner) {
      await emitWebhookEvent({
        userId: owner.userId,
        eventType: "agent.completed",
        payload: buildAgentCompletedPayload({ runId, chatId: owner.chatId }),
      });
    }
  }
  return applied;
}

interface FinalizeFailedParams extends TraceFields {
  runId: string;
  assistantMessageId: string | null;
  errorCode: string;
  errorMessage: string;
  /** The status the row must currently be in to accept this transition — `running` for the normal path, `queued` for a cancel-before-start, `waiting` for a stale/orphaned waitpoint (S3). */
  fromStatus: "queued" | "running" | "waiting";
}

/**
 * `queued`/`running`/`waiting` -> failed. Never touches already-persisted
 * text (S2-streaming-turn.md's worker-failure requirement: "leave the
 * already-persisted partial text exactly as it is"). Releases the hold.
 */
export async function finalizeFailed(params: FinalizeFailedParams): Promise<boolean> {
  const { runId, assistantMessageId, errorCode, errorMessage, fromStatus, chatId, traceId } = params;
  const applied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: runId, status: fromStatus },
      data: { status: "failed", errorCode, errorMessage, finishedAt: new Date() },
    });
    if (count === 0) return false;

    if (assistantMessageId) {
      await tx.message.update({ where: { id: assistantMessageId }, data: { status: "failed" } });
    }
    await releaseHoldTx(tx, runId, traceId);
    return true;
  });
  log.error("run.finalized", {
    runId,
    chatId,
    messageId: assistantMessageId ?? undefined,
    traceId,
    status: "failed",
    errorCode,
    fromStatus,
    applied,
  });
  if (applied) {
    const owner = await ownerAndChatForRun(runId);
    if (owner) {
      await emitWebhookEvent({
        userId: owner.userId,
        eventType: "agent.failed",
        payload: buildAgentFailedPayload({ runId, chatId: owner.chatId, errorCode }),
      });
    }
  }
  return applied;
}

interface FinalizeCancelledParams extends TraceFields {
  runId: string;
  assistantMessageId: string | null;
  fromStatus: "queued" | "running" | "waiting";
}

/** `queued`/`running`/`waiting` -> cancelled. Partial text preserved unchanged, hold released. */
export async function finalizeCancelled(params: FinalizeCancelledParams): Promise<boolean> {
  const { runId, assistantMessageId, fromStatus, chatId, traceId } = params;
  const applied = await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentRun.updateMany({
      where: { id: runId, status: fromStatus },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    if (count === 0) return false;

    if (assistantMessageId) {
      await tx.message.update({ where: { id: assistantMessageId }, data: { status: "cancelled" } });
    }
    await releaseHoldTx(tx, runId, traceId);
    return true;
  });
  log.info("run.finalized", {
    runId,
    chatId,
    messageId: assistantMessageId ?? undefined,
    traceId,
    status: "cancelled",
    fromStatus,
    applied,
  });
  return applied;
}
