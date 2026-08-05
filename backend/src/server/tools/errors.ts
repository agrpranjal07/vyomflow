/**
 * Provider error taxonomy: a generic HTTP/network error envelope shape,
 * plus classifyMediaToolError below for the taxonomy that actually
 * classifies live in-process media tool failures. Mirrors
 * src/server/openrouter/errors.ts's shape and rule (never echo the raw
 * provider/internal string as the user-safe message unless the provider's
 * own field is documented as user-facing).
 */
import { z } from "zod";
import type { MediaEngine } from "@/server/tools/registry";

export const ProviderErrorEnvelopeSchema = z.object({
  error: z.unknown(),
  message: z.string().optional(),
  code: z.string().optional(),
  details: z.unknown().optional(),
  traceId: z.string().optional(),
});
export type ProviderErrorEnvelope = z.infer<typeof ProviderErrorEnvelopeSchema>;

export interface ClassifiedToolError {
  errorCode: string;
  userMessage: string;
  retryable: boolean;
}

const RETRYABLE_CODES = new Set(["TIMEOUT", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"]);

function userSafeMessageForCode(code: string, httpStatus?: number): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "The media tool provider rejected the request credentials.";
    case "RATE_LIMITED":
      return "The media tool provider is temporarily rate-limited. Please try again shortly.";
    case "BAD_REQUEST":
      return "The media tool request was invalid.";
    case "PAYMENT_REQUIRED":
      return "The media tool provider reported an account/billing issue.";
    case "NOT_FOUND":
      return "The requested media tool run could not be found.";
    case "TIMEOUT":
      return "The media tool provider timed out. Please try again.";
    default:
      if (httpStatus === 429) return "The media tool provider is temporarily rate-limited. Please try again shortly.";
      if (httpStatus === 401) return "The media tool provider rejected the request credentials.";
      return "The media tool request could not be completed. Please try again.";
  }
}

/** Classifies a non-2xx HTTP response from a provider dispatch/schema/status call. */
export function classifyProviderHttpError(body: unknown, httpStatus: number): ClassifiedToolError {
  const parsed = ProviderErrorEnvelopeSchema.safeParse(body);
  const code = (parsed.success && parsed.data.code) || String(httpStatus);
  // A symbolic code's retryability comes from RETRYABLE_CODES; otherwise
  // (no symbolic code — code fell back to the raw httpStatus string) derive
  // it from the status: 429/5xx are transient, everything else is not.
  const retryable = RETRYABLE_CODES.has(code) || (!(parsed.success && parsed.data.code) && (httpStatus === 429 || httpStatus >= 500));
  return {
    errorCode: code,
    userMessage: userSafeMessageForCode(code, httpStatus),
    retryable,
  };
}

/** Classifies a network-level failure (timeout, DNS, connection reset) before any HTTP response arrived. */
export function classifyProviderNetworkError(): ClassifiedToolError {
  return {
    errorCode: "NETWORK_ERROR",
    userMessage: "The media tool provider could not be reached. Please try again.",
    retryable: true,
  };
}

/** Classifies caller-initiated cancellation (e.g. a user Stop) — never retryable, distinct from a network/timeout failure. */
export function classifyProviderCancellation(): ClassifiedToolError {
  return {
    errorCode: "CANCELLED",
    userMessage: "The media tool request was cancelled.",
    retryable: false,
  };
}

/**
 * Classifies a terminal FAILED provider run. Prefers the provider's own
 * `userMessage` when present and non-empty — it's documented/observed as
 * already user-facing, not raw internal diagnostics — falling back to a
 * generic message otherwise. Never exposes `error`'s raw (opaque, possibly
 * internal) value directly.
 */
export function classifyProviderRunFailure(userMessage: string | null | undefined): ClassifiedToolError {
  const trimmed = userMessage?.trim();
  return {
    errorCode: "TOOL_RUN_FAILED",
    userMessage: trimmed && trimmed.length > 0 ? trimmed : "The media tool run failed. Please try again.",
    retryable: false,
  };
}

/**
 * Classifies whatever `tool.execute()` threw
 * for one of the three real in-process media tools, into the same
 * `{errorCode, userMessage, retryable}` shape every other classifier here
 * uses. Dispatch design (first-to-see-all-three-taxonomies-together
 * judgment call, documented per this phase's report):
 *
 *   1. Each adapter's own named error class is the primary signal — a crop
 *      failure is always `crop_failed`, a Cloudflare generation failure is
 *      always `image_generation_failed`, an ffmpeg execution failure is
 *      always `merge_failed`, regardless of `engine` (defensive: `engine`
 *      is only used as a fallback label below, never to override a named
 *      error class's own classification).
 *   2. `MergeVideosValidationError` surfaces its own message directly as
 *      `userMessage` — it's a pre-spawn, deliberately user-safe, specific
 *      message already naming the offending clip pair (merge-videos.ts),
 *      not raw internal diagnostics like the other classes' messages.
 *   3. Anything else (a bare network/fetch failure common to all three
 *      adapters' own source-URL/reference-image downloads, e.g. `TypeError:
 *      fetch failed`, or a AbortError from ctx.signal, or truly unexpected)
 *      is classified as `source_download_failed` when its message looks
 *      network/fetch-shaped, else falls back to a generic
 *      `media_tool_failed` — deliberately never leaking the raw error's
 *      `.message` (which may contain ffmpeg stderr or a Cloudflare response
 *      body) as `userMessage`.
 */
export function classifyMediaToolError(engine: MediaEngine, error: unknown): ClassifiedToolError {
  const name = error instanceof Error ? error.name : undefined;

  if (name === "CropExtractError") {
    return { errorCode: "crop_failed", userMessage: "The image could not be cropped. Please try again.", retryable: false };
  }
  if (name === "CloudflareGenerationError") {
    return {
      errorCode: "image_generation_failed",
      userMessage: "The image could not be generated. Please try again.",
      retryable: false,
    };
  }
  if (name === "FfmpegExecutionError") {
    return { errorCode: "merge_failed", userMessage: "The videos could not be merged. Please try again.", retryable: false };
  }
  if (name === "MergeVideosValidationError") {
    // Already user-safe/specific (names the offending clip pair) — surfaced
    // verbatim, unlike every other branch here.
    const message = error instanceof Error ? error.message : "The merge request was invalid.";
    return { errorCode: "merge_invalid_input", userMessage: message, retryable: false };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const looksNetworkRelated =
    /fetch|network|ECONNRESET|ENOTFOUND|ETIMEDOUT|AbortError|TimeoutError|HTTP \d{3}/i.test(rawMessage) ||
    name === "AbortError" ||
    name === "TimeoutError";
  if (looksNetworkRelated) {
    return {
      errorCode: "source_download_failed",
      userMessage: "A required source file could not be downloaded. Please try again.",
      retryable: true,
    };
  }

  return {
    errorCode: "media_tool_failed",
    userMessage: `The ${engine} tool could not complete the request. Please try again.`,
    retryable: false,
  };
}
