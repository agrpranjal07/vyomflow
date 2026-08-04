import type { Fetcher } from "@/lib/api-client";
import { AgentRunDTOSchema, RealtimeAccessSchema, SendTurnResponseSchema, type AgentRunDTO, type RealtimeAccess, type SendTurnResponse } from "@/contracts/runs";
import type { CreateMessageRequest } from "@/contracts/messages";

export async function sendTurn(fetcher: Fetcher, chatId: string, body: CreateMessageRequest): Promise<SendTurnResponse> {
  const raw = await fetcher(`/api/v1/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify(body) });
  return SendTurnResponseSchema.parse(raw);
}

export async function getRun(fetcher: Fetcher, runId: string): Promise<AgentRunDTO> {
  const raw = await fetcher(`/api/v1/runs/${runId}`);
  return AgentRunDTOSchema.parse(raw);
}

export async function cancelRun(fetcher: Fetcher, runId: string): Promise<AgentRunDTO> {
  const raw = await fetcher(`/api/v1/runs/${runId}/cancel`, { method: "POST" });
  return AgentRunDTOSchema.parse(raw);
}

export async function getRealtimeToken(fetcher: Fetcher, runId: string): Promise<RealtimeAccess> {
  const raw = await fetcher(`/api/v1/runs/${runId}/realtime-token`);
  return RealtimeAccessSchema.parse(raw);
}
