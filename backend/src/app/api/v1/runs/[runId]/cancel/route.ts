import { authenticate } from "@/lib/auth";
import { handleOptions, json, notFound } from "@/lib/http";
import { AgentRunDTOSchema } from "@/contracts/runs";
import { getOwnedRun, toAgentRunDTO, verifyAgainstTrigger } from "@/services/runs";
import { finalizeCancelled } from "@/server/agent/persist";
import { cancelTriggerRun } from "@/server/dispatch";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";

export function OPTIONS() {
  return handleOptions();
}

/**
 * User-triggered Stop (S2-streaming-turn.md). Idempotent — a repeat call
 * on an already-terminal run is a no-op, never an error. `onCancel` never
 * fires for a run cancelled while still `queued` (verified against the
 * installed SDK: it only fires while actively executing), so this route
 * itself finalizes that case directly rather than depending on the hook.
 * For `running`, it sets `cancelRequestedAt` (the assignment's `stopping`
 * UI status is derived from this, not a separate enum value — S2
 * implementation plan §B) and defers the actual finalize to `onCancel`,
 * which has the persisted partial text available.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound();

  // No Trigger.dev run context in a Route Handler, so this request mints its
  // own trace id and threads it into everything it triggers (assignment §11).
  const traceId = crypto.randomUUID();
  log.info("run.cancel_requested", {
    runId: run.id,
    chatId: run.chatId,
    messageId: run.assistantMessageId ?? undefined,
    traceId,
    fromStatus: run.status,
  });

  if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") {
    // Already terminal — idempotent no-op.
    const toolInvocations = await listToolInvocationDTOs(run.id);
    return json(AgentRunDTOSchema.parse(toAgentRunDTO(run, toolInvocations)));
  }

  if (run.triggerRunId) {
    await cancelTriggerRun(run.triggerRunId).catch(() => {
      // Best-effort — our own DB transition below is the source of truth
      // regardless of whether Trigger.dev's own cancel call succeeds.
    });
  }

  if (run.status === "queued") {
    const cancelled = await finalizeCancelled({
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
      fromStatus: "queued",
      chatId: run.chatId,
      traceId,
    });
    if (!cancelled) {
      // Lost the race — the run moved out of `queued` (e.g. to `running`)
      // between our read above and this write. Fall back to the same
      // cancelRequestedAt signal the non-queued branch uses instead of
      // silently dropping the Stop request; onCancel picks it up once the
      // run is actually executing.
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: { in: ["running", "waiting"] } },
        data: { cancelRequestedAt: new Date() },
      });
    }
  } else {
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: run.status },
      data: { cancelRequestedAt: new Date() },
    });
  }

  const afterCancelRequest = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  // S6 fix (.claude/specs/S6-reliability-implementation-plan.md §7.2): check
  // Trigger.dev immediately rather than waiting out CANCEL_GRACE_MS — a
  // cancel against an already-dead worker (e.g. a killed local dev process)
  // can then resolve to `cancelled` within this same request/response
  // cycle. Falls back to reconcileIfStale's grace-gated check (and
  // ultimately the sweep, §7.3) as the bound if Trigger.dev is unreachable.
  const refreshed = await verifyAgainstTrigger(afterCancelRequest);
  const toolInvocations = await listToolInvocationDTOs(refreshed.id);
  return json(AgentRunDTOSchema.parse(toAgentRunDTO(refreshed, toolInvocations)));
}
