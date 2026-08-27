// GENERATED — do not edit. Source: 1173916808585c5b39a4dfd2d96256d6ec489be5:src/contracts/common.ts
/**
 * Shared Zod primitives reused across every contract file. Pure Zod only —
 * no Prisma types, no Next.js types (00-master-spec.md §2). This file (and
 * everything under src/contracts/**) is copied verbatim into the frontend
 * by `contracts:sync`.
 */
import { z } from "zod";

export const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export function PageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Typed, order-preserving content blocks — text/thinking/tool_use/
 * tool_result/reasoning/citation/usage (00-master-spec.md §6). S1 only
 * ever writes `text` blocks (user composer input); the full union exists
 * now so S2/S3's assistant/tool messages need no breaking contract change.
 */
export const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
export const ThinkingBlockSchema = z.object({ type: z.literal("thinking"), text: z.string() });
export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
// S3 (00-master-spec.md §6/§9 "Tool Detail" — sanitized inputs, outputs,
// duration, credits, user-safe failure details on the card). Additive over
// S1/S2's original shape: `toolUseId`/`output`/`isError` are unchanged;
// every field below is optional so no prior persisted block needs a
// backfill. `toolInvocationId` links back to the durable ToolInvocation row
// for detail-panel lookups.
export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  toolInvocationId: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(["DISPATCHING", "QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  creditUsed: z.number().nonnegative().optional(),
  resultUrls: z.array(z.url()).optional(),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
});
export const ReasoningBlockSchema = z.object({ type: z.literal("reasoning"), text: z.string() });
export const CitationBlockSchema = z.object({
  type: z.literal("citation"),
  url: z.url(),
  title: z.string().optional(),
});
export const UsageBlockSchema = z.object({
  type: z.literal("usage"),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  // Added for S2: the actually-routed model OpenRouter reports back
  // (response.model, e.g. "upstage/solar-pro-3:free" — openrouter/free
  // randomizes across a pool) and its cost in app credits, always 0 for the
  // LLM-only path per 00-master-spec.md §4 ("record OpenRouter usage at
  // zero application credits").
  model: z.string().optional(),
  costCredits: z.number().nonnegative().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ReasoningBlockSchema,
  CitationBlockSchema,
  UsageBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
