/**
 * Public-response shaping for `/api/public/v1/*` (S8 public-API-bonus,
 * Phase 3). Deliberately outside `src/contracts/**` — that directory is
 * copied verbatim into the frontend by `contracts:sync` under a checksum
 * guard, and a public-only shape must never ship there (same reasoning
 * that already keeps `openapi/registry.ts` out of it).
 */
import { z } from "zod";
import { MessageDTOSchema } from "@/contracts/messages";
import { AgentRunDTOSchema, type SendTurnResponse } from "@/contracts/runs";
import { PUBLIC_API_BASE_URL } from "@/lib/config";

export const PublicStreamAccessSchema = z.object({
  url: z.string(),
  fromIndex: z.number().int().nonnegative(),
});
export type PublicStreamAccess = z.infer<typeof PublicStreamAccessSchema>;

// Same shape as SendTurnResponseSchema, minus `realtime` (which leaks the
// Trigger.dev token/streamKey and internal run identifiers — see Phase 4's
// "why not just hand out the Trigger realtime token"). `stream` points at
// our own re-emitted SSE endpoint instead.
export const PublicSendTurnResponseSchema = z.object({
  chatId: z.string(),
  message: MessageDTOSchema,
  run: AgentRunDTOSchema,
  stream: PublicStreamAccessSchema,
});
export type PublicSendTurnResponse = z.infer<typeof PublicSendTurnResponseSchema>;

export function toPublicSendTurnResponse(dto: SendTurnResponse): PublicSendTurnResponse {
  const { realtime: _realtime, ...rest } = dto;
  return PublicSendTurnResponseSchema.parse({
    ...rest,
    stream: {
      url: `${PUBLIC_API_BASE_URL}/api/public/v1/runs/${rest.run.id}/stream`,
      // A fresh public subscriber has nothing rendered yet — always start
      // at 0, never `lastStreamIndex + 1` (that's a persistence checkpoint
      // for a client resuming a session it already has, see Phase 4).
      fromIndex: 0,
    },
  });
}
