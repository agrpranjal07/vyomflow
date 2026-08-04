/**
 * Run read/ownership/reconciliation service (S2 implementation plan §F).
 * The reconciler is the backstop for the terminal statuses that fire
 * neither `onCancel` nor `onFailure` — CRASHED, SYSTEM_FAILURE, TIMED_OUT,
 * EXPIRED (verified against the installed @trigger.dev/sdk's RunStatus
 * enum) — invoked opportunistically from the run-read and send paths so a
 * chat is never permanently locked by a dead run, without a scheduled
 * sweep (S6 owns that).
 */
import { runs as triggerRuns } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { finalizeCancelled, finalizeFailed } from "@/server/agent/persist";
import {
  RUN_STALE_AFTER_MS,
  RUN_ORPHAN_HARD_TIMEOUT_MS,
  TRIGGER_RETRIEVE_TIMEOUT_MS,
  CANCEL_GRACE_MS,
} from "@/lib/config";
import type { AgentRunDTO } from "@/contracts/runs";
import type { ToolInvocationDTO } from "@/contracts/tools";
import type { WaitpointDTO } from "@/contracts/waitpoints";
import type { AgentRun } from "@/generated/prisma/client";

/**
 * `toolInvocations` defaults to `[]` — no S2 call site loads the relation
 * yet (nothing dispatches a tool before S3's orchestration lands in
 * src/trigger/turn.ts). Callers that need real tool history pass it
 * explicitly; `src/services/tool-invocations.ts` is the source of the
 * mapped DTOs. `pendingWaitpoint` defaults to `null` so existing call sites
 * (send route, cancel route) are unaffected — only the GET run route (§7.1
 * reload-recovery) passes a real one.
 */
export function toAgentRunDTO(
  run: AgentRun,
  toolInvocations: ToolInvocationDTO[] = [],
  pendingWaitpoint: WaitpointDTO | null = null,
): AgentRunDTO {
  return {
    id: run.id,
    chatId: run.chatId,
    status: run.status,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    lastStreamIndex: run.lastStreamIndex,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    requestedModel: run.requestedModel,
    resolvedModel: run.resolvedModel,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    toolInvocations,
    totalCreditsUsed: toolInvocations.reduce((sum, t) => sum + (t.creditUsed ?? 0), 0),
    pendingWaitpoint,
  };
}

/** Ownership-scoped run lookup — non-leaking null for foreign/nonexistent, matching every other ownership check. */
export async function getOwnedRun(userId: string, runId: string): Promise<AgentRun | null> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, include: { chat: true } });
  if (!run || run.chat.ownerId !== userId || run.chat.deletedAt) return null;
  return run;
}

const TRIGGER_TERMINAL_CANCELLED = new Set(["CANCELED"]);
const TRIGGER_TERMINAL_FAILED = new Set(["CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]);

/**
 * If `run` is non-terminal and stale, checks Trigger.dev directly and
 * finalizes it. Returns the (possibly just-updated) row. A fresh/active
 * run is returned unchanged — this is cheap to call on every read.
 */
export async function reconcileIfStale(run: AgentRun): Promise<AgentRun> {
  if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") return run;

  const staleMs = Date.now() - run.updatedAt.getTime();

  // S6 fix (.claude/specs/S6-reliability-implementation-plan.md §7.2): a
  // requested cancellation must resolve fast, not wait for the general
  // RUN_STALE_AFTER_MS (5 min) staleness window — a dead worker that never
  // observes cancelRequestedAt would otherwise leave the UI showing
  // "stopping" for minutes. CANCEL_GRACE_MS is much shorter; once elapsed,
  // fall through to the same Trigger.dev verification below early. This
  // only *checks* sooner — it never force-finalizes a run Trigger.dev still
  // reports as genuinely active.
  const cancelGraceElapsed =
    run.cancelRequestedAt !== null && Date.now() - run.cancelRequestedAt.getTime() >= CANCEL_GRACE_MS;
  if (staleMs < RUN_STALE_AFTER_MS && !cancelGraceElapsed) return run;

  return verifyAgainstTrigger(run);
}

/**
 * The Trigger.dev-verification-and-finalize core shared by `reconcileIfStale`
 * (gated by staleness/cancel-grace above) and the cancel route (§7.2), which
 * calls this immediately and unconditionally right after stamping
 * `cancelRequestedAt` so a cancel against an already-dead worker can resolve
 * within the same request/response cycle instead of waiting out
 * `CANCEL_GRACE_MS`. Caller is responsible for the non-terminal/staleness
 * gating appropriate to its own context — this function always checks.
 */
export async function verifyAgainstTrigger(run: AgentRun): Promise<AgentRun> {
  if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") return run;

  const staleMs = Date.now() - run.updatedAt.getTime();

  if (!run.triggerRunId) {
    // The trigger call itself never confirmed — dispatch outcome unknown,
    // and it has been unknown for longer than one full turn should ever
    // take. Fail closed rather than leaving the chat locked forever.
    await finalizeFailed({
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
      errorCode: "dispatch_unconfirmed",
      errorMessage: "The response could not be started. Please try again.",
      fromStatus: run.status,
    });
  } else {
    // A Trigger.dev API failure here (network blip, transient outage) must
    // degrade gracefully — never block a normal run read or send-path
    // reconciliation check. Defer to DB state (leave the row untouched);
    // the hard-timeout branch below still fires on a later call once
    // staleMs justifies it, so a genuinely stuck run is not masked forever.
    // The installed SDK's ApiRequestOptions has no per-call signal/timeout
    // field, so a stalled request is raced against a deadline here instead
    // — a hang would otherwise block every caller of reconcileIfStale
    // (every run/send read) rather than reaching the null-fallback below.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      triggerRuns.retrieve(run.triggerRunId).catch(() => null),
      new Promise<null>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(null), TRIGGER_RETRIEVE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(deadlineTimer));
    if (!result) {
      // Trigger.dev itself is unreachable/erroring — our own clock is the
      // only signal available. Still apply the hard timeout (it does not
      // depend on Trigger.dev's report); otherwise leave the row alone.
      if (staleMs >= RUN_ORPHAN_HARD_TIMEOUT_MS) {
        await finalizeFailed({
          runId: run.id,
          assistantMessageId: run.assistantMessageId,
          errorCode: "orphaned_run_timeout",
          errorMessage: "The response was interrupted unexpectedly. The partial response above was preserved.",
          fromStatus: run.status,
        });
      }
    } else if (TRIGGER_TERMINAL_CANCELLED.has(result.status)) {
      await finalizeCancelled({ runId: run.id, assistantMessageId: run.assistantMessageId, fromStatus: run.status });
    } else if (TRIGGER_TERMINAL_FAILED.has(result.status)) {
      await finalizeFailed({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        errorCode: result.status.toLowerCase(),
        errorMessage: "The response was interrupted unexpectedly. The partial response above was preserved.",
        fromStatus: run.status,
      });
    } else if (result.status === "COMPLETED" || result.status === "FAILED") {
      // Trigger.dev believes the run reached a terminal state (via its own
      // onFailure path, most likely) but our DB write never landed — this
      // should be rare (finalize is the last statement in each hook), but
      // we cannot safely recover the true final text from here. Fail
      // closed with an explainable reason rather than guessing.
      await finalizeFailed({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        errorCode: "reconciliation_incomplete",
        errorMessage: "This response could not be fully confirmed. Please try again.",
        fromStatus: run.status,
      });
    } else if (staleMs >= RUN_ORPHAN_HARD_TIMEOUT_MS) {
      // Trigger.dev still reports this as active (QUEUED/EXECUTING/...)
      // but our own clock says it's been stale for far longer than any
      // real turn should take. Verified live: a hard-killed *local dev*
      // worker's run can stay reported EXECUTING indefinitely — waiting on
      // that signal forever is exactly the "stuck running" failure mode
      // this reconciler exists to close. Fail closed.
      await finalizeFailed({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        errorCode: "orphaned_run_timeout",
        errorMessage: "The response was interrupted unexpectedly. The partial response above was preserved.",
        fromStatus: run.status,
      });
    }
    // Otherwise (QUEUED/DEQUEUED/EXECUTING/WAITING/DELAYED/PENDING_VERSION,
    // within the hard timeout): genuinely still active — leave it alone,
    // next check re-verifies later.
  }

  const refreshed = await prisma.agentRun.findUnique({ where: { id: run.id } });
  return refreshed ?? run;
}
