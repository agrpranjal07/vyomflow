// GENERATED — do not edit. Source: 1173916808585c5b39a4dfd2d96256d6ec489be5:src/contracts/waitpoints.ts
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
 */
import { z } from "zod";

export const WaitpointKindSchema = z.enum(["CREDIT_APPROVAL", "CLARIFICATION"]);
export type WaitpointKind = z.infer<typeof WaitpointKindSchema>;

export const WaitpointStatusSchema = z.enum(["PENDING", "COMPLETED", "EXPIRED"]);
export type WaitpointStatus = z.infer<typeof WaitpointStatusSchema>;

export const CreditApprovalRequestPayloadSchema = z.object({
  toolName: z.string(),
  estimatedCredits: z.number().nonnegative(),
  threshold: z.number().nonnegative(),
});
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
