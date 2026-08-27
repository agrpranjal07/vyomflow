/**
 * Outbound webhook request signing (S8 Phase 6). Same serialize-once
 * discipline as backend/src/server/transloadit/signing.ts: the raw body
 * string is produced exactly once by the caller and passed in verbatim —
 * this module never re-serializes the payload, so the signature always
 * matches the bytes actually sent on the wire.
 *
 * Scheme: `X-Vyomflow-Signature: sha384=<hex(HMAC_SHA384(`${timestamp}.${rawBody}`, secret))>`.
 * Receivers are documented (docs/webhooks.mdx, Phase 7, if it ships) to
 * reject a `timestamp` more than 300s away from their own clock — this
 * module is the sender only and does not enforce that skew itself.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "X-Vyomflow-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Vyomflow-Timestamp";
export const WEBHOOK_EVENT_ID_HEADER = "X-Vyomflow-Event-Id";
export const WEBHOOK_DELIVERY_ATTEMPT_HEADER = "X-Vyomflow-Delivery-Attempt";

/** Documented receiver-side skew tolerance (this sender does not enforce it). */
export const WEBHOOK_SIGNATURE_MAX_SKEW_MS = 300_000;

/**
 * Signs `${timestamp}.${rawBody}` with HMAC-SHA384 against `secret`,
 * returning the header-ready `sha384=<hex>` value.
 */
export function signWebhookPayload(rawBody: string, timestamp: string, secret: string): string {
  const hex = createHmac("sha384", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `sha384=${hex}`;
}

/**
 * Constant-time comparison a receiver's own verification code would use —
 * exported so tests can prove the round-trip (sign then verify) without
 * duplicating the HMAC logic. Not used by the sender itself.
 */
export function verifyWebhookSignature(rawBody: string, timestamp: string, secret: string, signature: string): boolean {
  const expected = signWebhookPayload(rawBody, timestamp, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
