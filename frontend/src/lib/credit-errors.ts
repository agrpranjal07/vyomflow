import { ApiError } from "@/lib/api-client";

/**
 * True when `err` is the backend's `INSUFFICIENT_CREDITS` 402
 * (`backend/src/lib/http.ts`'s `insufficientCredits()`), from any of the
 * three admission points that can raise it: chat send, upload-params, or a
 * mid-turn tool reservation surfaced via `ToolStreamPart.errorCode`. Centralized
 * here so callers don't each hand-roll the status/code check.
 */
export function isInsufficientCredits(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 402 || err.code === "INSUFFICIENT_CREDITS");
}
