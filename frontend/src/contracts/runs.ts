// GENERATED — do not edit. Source: c9a2eb298ce02df0d3dd251bf7973b1da3131683:src/contracts/runs.ts
/**
 * S2 — durable streaming turn contracts. Pure Zod only, same rules as every
 * other file under src/contracts/** (00-master-spec.md §2): no Prisma
 * types, no Next.js types. Copied verbatim into the frontend by
 * `contracts:sync`.
 */
import { z } from "zod";
import { MessageDTOSchema } from "@/contracts/messages";
import { ToolInvocationDTOSchema, ToolInvocationStatusSchema } from "@/contracts/tools";
import { WaitpointDTOSchema } from "@/contracts/waitpoints";

// Mirrors prisma/schema.prisma's AgentRunStatus enum. Deliberately does NOT
// include a "cancelling"/"stopping" member — that UI status is derived on
// the client as `status === "running" && cancelRequestedAt != null`
// (see .claude/specs/S2-streaming-turn.md and the S2 implementation plan
// §B, "cancelling is derived, not an enum value").
export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunDTOSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: AgentRunStatusSchema,
  userMessageId: z.string(),
  assistantMessageId: z.string().nullable(),
  // Stream part/chunk index of the last durably-persisted chunk, -1 if none
  // yet. NOT a token count or character offset (00-master-spec.md §6).
  lastStreamIndex: z.number().int(),
  cancelRequestedAt: z.string().nullable(),
  requestedModel: z.string(),
  resolvedModel: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  // S3 — reload-recovery/detail-panel readback needs the run's tool history
  // without a second round-trip; §10 "total cost of the assistant turn".
  toolInvocations: z.array(ToolInvocationDTOSchema),
  totalCreditsUsed: z.number().nonnegative(),
  // S6 — reload-recovery for an in-progress approval/clarification, same
  // pattern as toolInvocations: the frontend needs this without a second
  // round-trip (.claude/specs/S6-reliability-implementation-plan.md §7.1).
  pendingWaitpoint: WaitpointDTOSchema.nullable(),
});
export type AgentRunDTO = z.infer<typeof AgentRunDTOSchema>;

// Per-run Trigger.dev Realtime access, minted on send and refreshable via
// GET /api/v1/runs/:runId/realtime-token (S2-streaming-turn.md — mandatory,
// not polish, since auth.createPublicToken's default expiry is short
// relative to a full agent turn).
export const RealtimeAccessSchema = z.object({
  runId: z.string(),
  streamKey: z.string(),
  accessToken: z.string(),
  expiresAt: z.string(),
});
export type RealtimeAccess = z.infer<typeof RealtimeAccessSchema>;

// The send route's response envelope (S2 Contradiction 3 — the assignment's
// Turn Lifecycle requires returning chatId/messageId/runId/realtime access;
// S1's bare MessageDTO response is superseded by this shape). `message` is
// the persisted user message; `run` is the freshly created AgentRun;
// `chatId` is redundant with `message.chatId` but kept top-level so a
// client doesn't have to reach into `message` for it, matching the
// assignment's literal wording.
export const SendTurnResponseSchema = z.object({
  chatId: z.string(),
  message: MessageDTOSchema,
  run: AgentRunDTOSchema,
  realtime: RealtimeAccessSchema,
});
export type SendTurnResponse = z.infer<typeof SendTurnResponseSchema>;

// One streams.define() part emitted by the agentTurn task. Self-describing
// (`index` explicit, not inferred from array position) so a client can
// verify no gap/duplicate independent of how useRealtimeStream orders
// `parts` — see S2 implementation plan §G.
//
// S3 (00-master-spec.md §4 amendment, per the approved S3 plan's "D1"
// decision, 2026-08-20): widened from a bare `{index, delta}` text part to
// a discriminated union so tool lifecycle events (pending/running/
// completed/failed) share the *same* stream and the *same* index space as
// text — `AgentRun.lastStreamIndex`'s resume semantics
// (`startIndex: lastStreamIndex + 1`) are completely unchanged by this;
// the frontend simply filters by `type`. This is a breaking contract
// change over S2's `{index, delta}` shape — S2-streaming-turn.md's
// streaming/resume acceptance criteria are marked NEEDS RE-VERIFICATION
// against this new shape (see that spec file).
// Reasoning-capture task: `channel` reuses this same text-part shape for
// `delta.reasoning` deltas instead of introducing a whole new part type —
// the frontend's existing text-stream handling applies as-is; only the
// render treatment differs per channel. Defaults to "text" so every
// pre-existing producer/consumer of this schema is unaffected.
export const TextStreamPartSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.literal("text"),
  delta: z.string(),
  channel: z.enum(["text", "reasoning"]).default("text"),
});
export const ToolStreamPartSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.literal("tool"),
  toolInvocationId: z.string(),
  name: z.string(),
  status: ToolInvocationStatusSchema,
  creditUsed: z.number().nonnegative().optional(),
  resultUrls: z.array(z.url()).optional(),
  errorMessage: z.string().optional(),
  // Machine-readable failure reason (currently only "insufficient_credits",
  // set by src/trigger/turn.ts's reserveAdditional failure path) so the
  // client can distinguish a credit exhaustion from any other tool failure
  // without string-matching errorMessage.
  errorCode: z.string().optional(),
});
// S6 — realtime delivery of a waitpoint's creation/resolution without
// waiting on a REST round-trip, mirroring the tool part's own
// DISPATCHING/COMPLETED-style status transitions.
export const WaitpointStreamPartSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.literal("waitpoint"),
  waitpoint: WaitpointDTOSchema,
});
export const TurnStreamPartSchema = z.discriminatedUnion("type", [
  TextStreamPartSchema,
  ToolStreamPartSchema,
  WaitpointStreamPartSchema,
]);
export type TurnStreamPart = z.infer<typeof TurnStreamPartSchema>;
export type TextStreamPart = z.infer<typeof TextStreamPartSchema>;
export type ToolStreamPart = z.infer<typeof ToolStreamPartSchema>;
export type WaitpointStreamPart = z.infer<typeof WaitpointStreamPartSchema>;

export const AgentRunIdParamSchema = z.object({
  runId: z.string().min(1),
});
