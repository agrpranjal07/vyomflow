/**
 * S8 — public SSE event schema for `GET /api/public/v1/runs/{runId}/stream`
 * (Phase 4 of the public-API-key plan). Deliberately NOT part of the
 * `src/contracts/**` set that `contracts:sync` copies into the frontend
 * (00-master-spec.md §2) — this is a public-API-only, vendor-neutral wire
 * shape, not something the first-party frontend consumes.
 *
 * KNOWN ISSUE (see this route's implementation report): `scripts/
 * contracts-sync.ts` recursively lists every `.ts` file under `src/
 * contracts/` with no include/exclude list, so this file — sitting in that
 * same directory per this slice's assigned path — WILL be swept into a
 * future `pnpm contracts:sync` run despite the intent above. Fixing that
 * requires editing contracts-sync.ts, which is out of this slice's owned
 * files; flagged for a follow-up rather than silently left unmentioned.
 *
 * Derived from `TurnStreamPartSchema` (src/contracts/runs.ts) — the
 * internal `text`/`tool`/`waitpoint` discriminated union — but re-shaped
 * into named, single-purpose public events rather than one shared
 * discriminated union, and enriched with fields the internal schema
 * intentionally does not carry (`turnIndex`/`callIndex`/`toolCallId` on
 * tool events — see the route's mapper for why: enriching from
 * ToolInvocation, never widening ToolStreamPartSchema itself).
 */
import { z } from "zod";
import { AgentRunStatusSchema } from "@/contracts/runs";
import { ToolInvocationStatusSchema } from "@/contracts/tools";
import { WaitpointDTOSchema } from "@/contracts/waitpoints";

export const PublicStreamEventTypeSchema = z.enum([
  "run.status",
  "message.delta",
  "tool.status",
  "waitpoint.created",
  "waitpoint.resolved",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "stream.reset",
]);
export type PublicStreamEventType = z.infer<typeof PublicStreamEventTypeSchema>;

/** Snapshot event — sent once per connection, immediately after `: connected`. */
export const PublicRunStatusEventSchema = z.object({
  runId: z.string(),
  status: AgentRunStatusSchema,
  // Reconciliation cursor only (a persistence checkpoint) — never the
  // default resume point for a fresh subscriber. See the route's
  // `startIndex` derivation.
  lastStreamIndex: z.number().int(),
  cancelRequestedAt: z.string().nullable(),
});
export type PublicRunStatusEvent = z.infer<typeof PublicRunStatusEventSchema>;

export const PublicMessageDeltaEventSchema = z.object({
  index: z.number().int().nonnegative(),
  channel: z.enum(["text", "reasoning"]),
  delta: z.string(),
});
export type PublicMessageDeltaEvent = z.infer<typeof PublicMessageDeltaEventSchema>;

/**
 * Ordering key is `(turnIndex, callIndex)`, never array position or arrival
 * order — parallel tool calls are always represented as distinct events
 * keyed by `toolInvocationId`, never collapsed into a single field.
 */
export const PublicToolStatusEventSchema = z.object({
  index: z.number().int().nonnegative(),
  toolInvocationId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  turnIndex: z.number().int().nonnegative(),
  callIndex: z.number().int().nonnegative(),
  status: ToolInvocationStatusSchema,
  creditUsed: z.number().nonnegative().optional(),
  resultUrls: z.array(z.url()).optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
});
export type PublicToolStatusEvent = z.infer<typeof PublicToolStatusEventSchema>;

export const PublicWaitpointEventSchema = z.object({
  index: z.number().int().nonnegative(),
  waitpoint: WaitpointDTOSchema,
});
export type PublicWaitpointEvent = z.infer<typeof PublicWaitpointEventSchema>;

/** `run.completed` / `run.failed` / `run.cancelled` — terminal, closes the stream. */
export const PublicRunTerminalEventSchema = z.object({
  runId: z.string(),
  status: AgentRunStatusSchema,
  assistantMessageId: z.string().nullable(),
  totalCreditsUsed: z.number().nonnegative(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});
export type PublicRunTerminalEvent = z.infer<typeof PublicRunTerminalEventSchema>;

/** Emitted at the 285s graceful-close boundary — expected protocol, not an error. */
export const PublicStreamResetEventSchema = z.object({
  reason: z.literal("duration_limit"),
  nextFromIndex: z.number().int().nonnegative(),
});
export type PublicStreamResetEvent = z.infer<typeof PublicStreamResetEventSchema>;

/** Per-event-type schema map — mainly useful for tests asserting shape by event name. */
export const PublicStreamEventSchemas = {
  "run.status": PublicRunStatusEventSchema,
  "message.delta": PublicMessageDeltaEventSchema,
  "tool.status": PublicToolStatusEventSchema,
  "waitpoint.created": PublicWaitpointEventSchema,
  "waitpoint.resolved": PublicWaitpointEventSchema,
  "run.completed": PublicRunTerminalEventSchema,
  "run.failed": PublicRunTerminalEventSchema,
  "run.cancelled": PublicRunTerminalEventSchema,
  "stream.reset": PublicStreamResetEventSchema,
} as const satisfies Record<PublicStreamEventType, z.ZodTypeAny>;
