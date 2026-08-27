/**
 * S8 Phase 5 — thin adapters over the same `src/services/*` functions the
 * REST routes use (per the plan: "never `src/trigger/turn.ts` directly").
 * Kept out of `server.ts` so each tool handler there stays a short, readable
 * call into one named action.
 */
import type { ContentBlock } from "@/contracts/common";
import { getOwnedChat } from "@/services/chats";
import { createTurn, ActiveRunExistsError, InsufficientCreditsError } from "@/services/send-turn";
import { getOwnedRun, toAgentRunDTO, verifyAgainstTrigger } from "@/services/runs";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { finalizeCancelled } from "@/server/agent/persist";
import { cancelTriggerRun, dispatchAgentTurn } from "@/server/dispatch";
import { checkAndIncrementRateLimit, RateLimitedError } from "@/services/rate-limit";
import { resolveRequestedModel } from "@/lib/model-selection";
import { prisma } from "@/lib/db";
import type { AgentRun } from "@/generated/prisma/client";

export { ActiveRunExistsError, InsufficientCreditsError, RateLimitedError };

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found.");
    this.name = "ChatNotFoundError";
  }
}

/**
 * Dispatch a new turn — same rate-limit -> admit-credit -> persist ->
 * dispatch-idempotently sequence as `POST /api/v1/chats/:chatId/messages`
 * (src/app/api/v1/chats/[chatId]/messages/route.ts), reached through
 * `src/server/dispatch.ts` rather than `src/trigger/turn.ts` directly so this
 * route's serverless bundle never pulls in `sharp`/the tool registry.
 */
export async function sendMessage(params: {
  userId: string;
  chatId: string;
  content: ContentBlock[];
  attachmentIds: string[];
  model?: string;
}): Promise<{ messageId: string; run: AgentRun; triggerRunId: string }> {
  const { userId, chatId, content, attachmentIds, model } = params;
  if (!(await getOwnedChat(userId, chatId))) throw new ChatNotFoundError();

  await checkAndIncrementRateLimit(userId);

  const requestedModel = resolveRequestedModel(model);
  const { message, run } = await createTurn({ chatId, userId, content, attachmentIds, requestedModel });

  const { triggerRunId } = await dispatchAgentTurn({
    runId: run.id,
    chatId,
    userMessageId: message.id,
    userId,
    requestedModel,
  });

  await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } }).catch(() => {
    // Best-effort, mirrors the REST send route's own retry-then-log
    // idiom — the run is genuinely dispatched regardless of this write.
  });

  return { messageId: message.id, run: { ...run, triggerRunId }, triggerRunId };
}

/** Idempotent Stop — same sequence as `POST /api/v1/runs/:runId/cancel`. */
export async function cancelRun(userId: string, runId: string) {
  const run = await getOwnedRun(userId, runId);
  if (!run) return null;

  if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") {
    const toolInvocations = await listToolInvocationDTOs(run.id);
    return toAgentRunDTO(run, toolInvocations);
  }

  if (run.triggerRunId) {
    await cancelTriggerRun(run.triggerRunId).catch(() => {});
  }

  if (run.status === "queued") {
    const cancelled = await finalizeCancelled({ runId: run.id, assistantMessageId: run.assistantMessageId, fromStatus: "queued" });
    if (!cancelled) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: { in: ["running", "waiting"] } },
        data: { cancelRequestedAt: new Date() },
      });
    }
  } else {
    await prisma.agentRun.updateMany({ where: { id: run.id, status: run.status }, data: { cancelRequestedAt: new Date() } });
  }

  const afterCancelRequest = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  const refreshed = await verifyAgainstTrigger(afterCancelRequest);
  const toolInvocations = await listToolInvocationDTOs(refreshed.id);
  return toAgentRunDTO(refreshed, toolInvocations);
}
