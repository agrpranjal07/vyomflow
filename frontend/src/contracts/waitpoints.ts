// GENERATED — do not edit. Source: efa62177f60585ee7502f39b7ea874721096b9e9:src/contracts/waitpoints.ts
/**
 * S6 — Waitpoint contracts (.claude/specs/S6-reliability-implementation-plan.md
 * §6.2/§6.2a/§7.1). Pure Zod only, same rules as every other file under
 * src/contracts/** (00-master-spec.md §2): no Prisma types, no Next.js
 * types. Copied verbatim into the frontend by `contracts:sync`.
 *
 * Two kinds share one row shape and one resume mechanism but carry
 * different request/resolved payloads — both schemas below are
 * kind-discriminated unions so the wire contract itself enforces the right
 * shape per kind, rather than trusting a caller to send the correct fields.
 * A CREDIT_APPROVAL request payload may cover multiple calls in one round
 * (approval is all-or-nothing per round).
 */
import { z } from "zod";

export const WaitpointKindSchema = z.enum(["CREDIT_APPROVAL", "CLARIFICATION"]);
export type WaitpointKind = z.infer<typeof WaitpointKindSchema>;

export const WaitpointStatusSchema = z.enum(["PENDING", "COMPLETED", "EXPIRED"]);
export type WaitpointStatus = z.infer<typeof WaitpointStatusSchema>;

export const CreditApprovalCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  estimatedCredits: z.number().nonnegative(),
});
export type CreditApprovalCall = z.infer<typeof CreditApprovalCallSchema>;

const CreditApprovalRequestPayloadObjectSchema = z.object({
  calls: z.array(CreditApprovalCallSchema).min(1),
  estimatedCredits: z.number().nonnegative(), // round total across `calls`
  threshold: z.number().nonnegative(),
});

/**
 * Pre-2026-08-29 rows (and a worker still running that code — the
 * Trigger.dev worker deploys independently of this API, so version skew
 * between them is a normal, recurring condition, not a one-off migration
 * window) persist the older single-call shape
 * `{toolName, estimatedCredits, threshold}`. Upgrade it to the round shape
 * before validating, so every consumer of this schema — this backend's own
 * `.parse`, the frontend's REST parse, and the frontend's realtime-stream
 * parse (all copied verbatim from this file by `contracts:sync`) — sees one
 * shape and none of them needs its own compatibility branch.
 */
export const CreditApprovalRequestPayloadSchema = z.preprocess((raw) => {
  const p = raw as Record<string, unknown> | null;
  if (!p || Array.isArray(p.calls)) return raw; // already current shape (or malformed enough to fail below either way)
  if (typeof p.toolName !== "string") return raw;
  return {
    calls: [{ toolCallId: "", toolName: p.toolName, estimatedCredits: p.estimatedCredits ?? 0 }],
    estimatedCredits: p.estimatedCredits ?? 0,
    threshold: p.threshold ?? 0,
  };
}, CreditApprovalRequestPayloadObjectSchema);
export const ClarificationRequestPayloadSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).optional(),
});

export const CreditApprovalResolvedPayloadSchema = z.object({
  approved: z.boolean(),
  respondedAt: z.string(),
});
export const ClarificationResolvedPayloadSchema = z.object({
  answer: z.string(),
  respondedAt: z.string(),
});

// Discriminated on `kind` so a CREDIT_APPROVAL row can never be rendered
// with a CLARIFICATION payload shape or vice versa.
export const WaitpointDTOSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    agentRunId: z.string(),
    kind: z.literal("CREDIT_APPROVAL"),
    status: WaitpointStatusSchema,
    requestPayload: CreditApprovalRequestPayloadSchema,
    resolvedPayload: CreditApprovalResolvedPayloadSchema.nullable(),
    expiresAt: z.string(),
    resolvedAt: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    agentRunId: z.string(),
    kind: z.literal("CLARIFICATION"),
    status: WaitpointStatusSchema,
    requestPayload: ClarificationRequestPayloadSchema,
    resolvedPayload: ClarificationResolvedPayloadSchema.nullable(),
    expiresAt: z.string(),
    resolvedAt: z.string().nullable(),
  }),
]);
export type WaitpointDTO = z.infer<typeof WaitpointDTOSchema>;

// The respond route's request body — kind-discriminated so a
// CREDIT_APPROVAL waitpoint rejects a `{answer}` body and vice versa,
// before ever touching the DB.
export const RespondToWaitpointRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CREDIT_APPROVAL"), approved: z.boolean() }),
  z.object({ kind: z.literal("CLARIFICATION"), answer: z.string().min(1).max(2000) }),
]);
export type RespondToWaitpointRequest = z.infer<typeof RespondToWaitpointRequestSchema>;

export const WaitpointIdParamSchema = z.object({
  waitpointId: z.string().min(1),
});
