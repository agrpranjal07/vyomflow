/**
 * OpenRouter error taxonomy — non-200 HTTP error envelopes AND mid-stream
 * SSE `error` chunks share this shape (S2 implementation plan §E, verified
 * against openrouter.ai/docs/api_reference/{errors,errors-and-debugging}).
 *
 * `code` is documented as polymorphic: a number (`429`) in some examples, a
 * string (`"server_error"`) in others. `metadata` — and everything inside
 * it — may be absent entirely (the 402/502 examples carry none). Parse
 * permissively; never assume a field is present.
 */
import { z } from "zod";

export const OpenRouterErrorPayloadSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type OpenRouterErrorPayload = z.infer<typeof OpenRouterErrorPayloadSchema>;

/**
 * Retry policy is keyed on `metadata.error_type` when present — the stable,
 * normalized taxonomy OpenRouter documents — falling back to `code`, then
 * to the HTTP status the caller observed. `openrouter/free` has no paid
 * fallback (00-master-spec.md §1), so "retryable" here only ever informs
 * whether it's *safe* to retry the same free call — it never triggers a
 * paid attempt.
 */
const RETRYABLE_ERROR_TYPES = new Set(["provider_overloaded", "provider_unavailable", "server", "timeout"]);

const NEVER_RETRY_ERROR_TYPES = new Set([
  "rate_limit_exceeded",
  "content_policy_violation",
  "context_length_exceeded",
  "payment_required",
]);

export interface ClassifiedOpenRouterError {
  errorType: string;
  errorCode: string;
  retryable: boolean;
  userMessage: string;
}

function userSafeMessage(errorType: string): string {
  switch (errorType) {
    case "rate_limit_exceeded":
      return "OpenRouter's free tier is temporarily rate-limited. Please try again shortly.";
    case "payment_required":
      return "The AI provider reported an account issue. Please try again later.";
    case "content_policy_violation":
      return "The request was blocked by the AI provider's content policy.";
    case "context_length_exceeded":
      return "This conversation is too long for the model to process.";
    case "provider_overloaded":
    case "provider_unavailable":
    case "server":
      return "The AI provider is temporarily unavailable. Please try again.";
    case "timeout":
      return "The AI provider timed out. Please try again.";
    default:
      return "The AI response could not be completed. Please try again.";
  }
}

/**
 * `payload.code` is a required field (a stringified HTTP status in most
 * observed error bodies, e.g. "429"), so it's effectively always present —
 * preferring it over `httpStatus` made the httpStatus branch dead code and
 * left the result outside the RETRYABLE/NEVER_RETRY taxonomy entirely.
 * Normalize the numeric HTTP status into that same symbolic taxonomy instead.
 */
function normalizeHttpStatus(status: number): string | undefined {
  switch (status) {
    case 402:
      return "payment_required";
    case 408:
    case 504:
      return "timeout";
    case 429:
      return "rate_limit_exceeded";
    case 500:
      return "server";
    case 502:
    case 503:
      return "provider_unavailable";
    default:
      return undefined;
  }
}

export function classifyOpenRouterError(
  payload: OpenRouterErrorPayload,
  httpStatus?: number,
): ClassifiedOpenRouterError {
  // `metadata.error_type` is `unknown` in the parsed schema — only trust it
  // when it's actually a non-empty string, never coerce an unexpected
  // shape (object/number) into the taxonomy below.
  const rawErrorType = payload.metadata?.error_type;
  const errorType = typeof rawErrorType === "string" && rawErrorType.length > 0 ? rawErrorType : undefined;
  const codeAsString = String(payload.code);
  const hasUsableCode = codeAsString.length > 0;
  // A `code` that is itself a taxonomy value ("provider_overloaded") is more
  // specific than the HTTP status wrapping it, so it wins — otherwise a 429
  // carrying code "provider_overloaded" would be reclassified as
  // rate_limit_exceeded (retryable -> never-retry), and a 500 carrying code
  // "content_policy_violation" as server (never-retry -> retryable). Only
  // when `code` carries no taxonomy signal (a stringified status, "unknown",
  // "") does the normalized HTTP status decide.
  const codeIsTaxonomyValue =
    hasUsableCode && (RETRYABLE_ERROR_TYPES.has(codeAsString) || NEVER_RETRY_ERROR_TYPES.has(codeAsString));
  const resolvedType =
    errorType ??
    (codeIsTaxonomyValue
      ? codeAsString
      : httpStatus !== undefined
        ? (normalizeHttpStatus(httpStatus) ?? String(httpStatus))
        : hasUsableCode
          ? codeAsString
          : "unknown");

  let retryable = false;
  if (RETRYABLE_ERROR_TYPES.has(resolvedType)) retryable = true;
  if (NEVER_RETRY_ERROR_TYPES.has(resolvedType)) retryable = false;

  return {
    errorType: resolvedType,
    errorCode: String(payload.code),
    retryable,
    userMessage: userSafeMessage(resolvedType),
  };
}

/** Best-effort parse of a non-200 response body into the error envelope. */
export function parseOpenRouterErrorBody(body: unknown): OpenRouterErrorPayload | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const result = OpenRouterErrorPayloadSchema.safeParse((body as { error: unknown }).error);
  return result.success ? result.data : undefined;
}
