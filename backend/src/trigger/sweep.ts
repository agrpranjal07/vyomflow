/**
 * S6 scheduled reconciliation sweep (.claude/specs/S6-reliability-implementation-plan.md
 * §7.3) — the backstop for every non-terminal state this codebase's other
 * reconcilers only check lazily/opportunistically (on a run/send read, on a
 * cancel). Runs once a minute; a single pass covers five independent stale-
 * state classes, each reusing the same reconcile/finalize helpers the
 * request-path code already uses rather than reimplementing them:
 *
 *   1. AgentRun rows queued/running/waiting -> reconcileIfStale (existing).
 *   2. ToolInvocation rows stuck DISPATCHING/RUNNING/QUEUED past the orphan
 *      timeout -> unconditionally failed closed (sweepOrphanedToolInvocations
 *      below) — a media-tool invocation has no remote run to reconcile
 *      against, so there's nothing to distinguish or retry.
 *   3. Waitpoint rows PENDING past expiresAt -> expireWaitpoint, then
 *      release the hold and fail the run closed (§6.3 "Expiry").
 *   4. CreditHold rows OPEN whose AgentRun already reached a terminal
 *      status -> releaseHoldStandalone (a hold that should have been
 *      released by whatever finalized the run, but wasn't, for any reason).
 *   5. Chat rows with zero messages older than EMPTY_CHAT_ORPHAN_TIMEOUT_MS
 *      -> hard-deleted. A chat can be created (UI send race, public API
 *      "create chat" call, MCP vyomflow_create_chat) without a message ever
 *      following it; listChats already hides these from every surface
 *      (messages: { some: {} }), so this only prunes rows nothing shows —
 *      never a chat a user can currently see.
 */
import { schedules } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { reconcileIfStale } from "@/services/runs";
import { markToolFailed } from "@/services/tool-invocations";
import { expireWaitpoint } from "@/services/waitpoints";
import { releaseHoldStandalone } from "@/services/credits";
import { finalizeFailed } from "@/server/agent/persist";
import {
  TOOL_ORPHAN_TIMEOUT_MS,
  RUN_STALE_AFTER_MS,
  CANCEL_GRACE_MS,
  SWEEP_BATCH_SIZE,
  EMPTY_CHAT_ORPHAN_TIMEOUT_MS,
} from "@/lib/config";

const WAITPOINT_EXPIRY_MESSAGES: Record<"CREDIT_APPROVAL" | "CLARIFICATION", string> = {
  CREDIT_APPROVAL: "Approval expired — you can continue later",
  CLARIFICATION: "The agent's question went unanswered — you can continue later",
};

async function sweepStaleRuns(): Promise<void> {
  const now = Date.now();
  // Mirrors reconcileIfStale's own staleness test exactly (services/runs.ts)
  // so the WHERE never diverges from the in-memory guard it's meant to
  // optimize, not replace (S7 plan §4.4/§6.5, T27 pins this agreement):
  // staleMs >= RUN_STALE_AFTER_MS, or a requested cancel has sat unresolved
  // past CANCEL_GRACE_MS. Pushing this into the WHERE lets the existing
  // AgentRun @@index([status, updatedAt]) serve the query instead of
  // fetching every active run every minute.
  const staleRuns = await prisma.agentRun.findMany({
    where: {
      status: { in: ["queued", "running", "waiting"] },
      OR: [
        { updatedAt: { lte: new Date(now - RUN_STALE_AFTER_MS) } },
        { cancelRequestedAt: { lte: new Date(now - CANCEL_GRACE_MS) } },
      ],
    },
    take: SWEEP_BATCH_SIZE,
  });
  for (const run of staleRuns) {
    // reconcileIfStale re-checks staleness in memory — the backstop of
    // record, not a redundant check to drop now that the WHERE is bounded.
    await reconcileIfStale(run);
  }
}

/**
 * VyomFlow (Phase 3 Task 3.3): the old two-branch split (reconcile via a
 * remote reference-implementation GET when a run id was set; log-only when
 * it wasn't) no longer applies — a media-tool invocation has no remote run to reconcile
 * against, only its own in-process execute() which either finishes (and
 * settles the row itself) or dies with the row stuck non-terminal. Any row
 * stuck DISPATCHING/RUNNING/QUEUED past the orphan timeout is unconditionally
 * failed closed, same as the interrupted-re-entry path in tool.ts — never
 * auto-retried, since there is no way to know whether a died-mid-execute
 * engine's side effects are safe to redo.
 */
async function sweepOrphanedToolInvocations(): Promise<void> {
  const cutoff = new Date(Date.now() - TOOL_ORPHAN_TIMEOUT_MS);

  const orphaned = await prisma.toolInvocation.findMany({
    where: { status: { in: ["DISPATCHING", "RUNNING", "QUEUED"] }, updatedAt: { lt: cutoff } },
    take: SWEEP_BATCH_SIZE,
  });
  for (const invocation of orphaned) {
    const durationMs = invocation.startedAt ? Date.now() - invocation.startedAt.getTime() : 0;
    await markToolFailed({
      toolInvocationId: invocation.id,
      errorCode: "orphaned",
      errorMessage: "The tool run was interrupted and did not finish.",
      durationMs,
    });
  }
}

async function sweepExpiredWaitpoints(): Promise<void> {
  const expired = await prisma.waitpoint.findMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    take: SWEEP_BATCH_SIZE,
  });
  for (const waitpoint of expired) {
    const didExpire = await prisma.$transaction((tx) => expireWaitpoint(tx, waitpoint.id));
    if (!didExpire) continue;

    const run = await prisma.agentRun.findUnique({ where: { id: waitpoint.agentRunId } });
    if (!run) continue;

    await releaseHoldStandalone(run.id);
    await finalizeFailed({
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
      errorCode: "waitpoint_expired",
      errorMessage: WAITPOINT_EXPIRY_MESSAGES[waitpoint.kind],
      fromStatus: "waiting",
    });
  }
}

async function sweepOrphanedHolds(): Promise<void> {
  const openHolds = await prisma.creditHold.findMany({
    where: { status: "OPEN", run: { status: { in: ["completed", "failed", "cancelled"] } } },
    take: SWEEP_BATCH_SIZE,
  });
  for (const hold of openHolds) {
    await releaseHoldStandalone(hold.runId);
  }
}

/**
 * Hard delete, not soft delete — an empty chat has nothing a user could
 * have referenced (no messages, no run, no share link), so there's no
 * "undo" scenario to preserve the row for. Cascades to any Attachment rows
 * left bound to it (schema: Attachment.chat onDelete: Cascade) — an upload
 * attached but never sent within the grace period is exactly the same kind
 * of abandoned-draft orphan.
 */
async function sweepEmptyChats(): Promise<void> {
  const cutoff = new Date(Date.now() - EMPTY_CHAT_ORPHAN_TIMEOUT_MS);
  // findMany + deleteMany(id in [...]), not one unbounded deleteMany --
  // keeps this pass bounded by SWEEP_BATCH_SIZE like every other sweep here.
  const orphaned = await prisma.chat.findMany({
    where: { createdAt: { lt: cutoff }, messages: { none: {} } },
    select: { id: true },
    take: SWEEP_BATCH_SIZE,
  });
  if (orphaned.length === 0) return;
  await prisma.chat.deleteMany({ where: { id: { in: orphaned.map((c) => c.id) } } });
}

export const reliabilitySweep = schedules.task({
  id: "reliability-sweep",
  // Every minute — matches SWEEP_INTERVAL_MS's intent (a plain millisecond
  // interval constant, not directly usable here since schedules.task takes
  // a cron expression, not an interval).
  cron: "*/1 * * * *",
  run: async () => {
    await sweepStaleRuns();
    await sweepOrphanedToolInvocations();
    await sweepExpiredWaitpoints();
    await sweepOrphanedHolds();
    await sweepEmptyChats();
  },
});
