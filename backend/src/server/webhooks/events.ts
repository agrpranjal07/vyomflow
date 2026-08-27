/**
 * S8 Phase 6 — outbound webhook event payload shapes. Each is a small,
 * stable JSON object (runId/chatId/status/timestamps, plus tool identity
 * for `tool.completed`) — never a Trigger.dev internal id/token beyond what
 * is already public via the REST surface (same rule Phase 3/4 apply to
 * `/api/public/v1`). Kept in server/webhooks/, not src/contracts/ — these
 * are receiver-facing wire payloads for a feature with no frontend UI, not
 * something `contracts:sync` needs to carry to the frontend.
 */

export type WebhookEventType = "agent.started" | "agent.completed" | "agent.failed" | "tool.completed";

interface AgentLifecycleEventPayload {
  runId: string;
  chatId: string;
  status: "running" | "completed" | "failed";
  occurredAt: string;
}

interface AgentFailedEventPayload extends AgentLifecycleEventPayload {
  status: "failed";
  errorCode: string;
}

export interface ToolCompletedEventPayload {
  runId: string;
  chatId: string;
  toolInvocationId: string;
  name: string;
  status: "COMPLETED";
  creditUsed: number | null;
  occurredAt: string;
}

export type WebhookEventPayload = AgentLifecycleEventPayload | AgentFailedEventPayload | ToolCompletedEventPayload;

export function buildAgentStartedPayload(params: { runId: string; chatId: string }): AgentLifecycleEventPayload {
  return { runId: params.runId, chatId: params.chatId, status: "running", occurredAt: new Date().toISOString() };
}

export function buildAgentCompletedPayload(params: { runId: string; chatId: string }): AgentLifecycleEventPayload {
  return { runId: params.runId, chatId: params.chatId, status: "completed", occurredAt: new Date().toISOString() };
}

export function buildAgentFailedPayload(params: { runId: string; chatId: string; errorCode: string }): AgentFailedEventPayload {
  return {
    runId: params.runId,
    chatId: params.chatId,
    status: "failed",
    errorCode: params.errorCode,
    occurredAt: new Date().toISOString(),
  };
}

export function buildToolCompletedPayload(params: {
  runId: string;
  chatId: string;
  toolInvocationId: string;
  name: string;
  creditUsed: number | null;
}): ToolCompletedEventPayload {
  return {
    runId: params.runId,
    chatId: params.chatId,
    toolInvocationId: params.toolInvocationId,
    name: params.name,
    status: "COMPLETED",
    creditUsed: params.creditUsed,
    occurredAt: new Date().toISOString(),
  };
}
