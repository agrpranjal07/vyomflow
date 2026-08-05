/**
 * Transloadit Assembly request signing (S7 asset ingestion). Same
 * lazy-env-read pattern used by the codebase's other external-API clients: secrets are read from
 * `process.env` at call time, never at module load, so tests can inject
 * them via `beforeEach` and nothing ever captures a stale/empty value into
 * a module-level constant.
 *
 * Signing scheme verified against Transloadit's own docs (Context7,
 * 2026-08-20): `signature = "sha384:" + hex(HMAC-SHA384(paramsJsonString,
 * authSecret))`, where `paramsJsonString` is serialized exactly once and
 * reused verbatim as both the signed payload and the request field — never
 * re-serialized between signing and sending.
 */
import { createHmac, randomUUID } from "node:crypto";
import { TRANSLOADIT_ASSEMBLY_SIGN_TTL_MS } from "@/lib/config";

/** Thrown when a required Transloadit env var is missing/empty. Message never includes the (absent) secret value. */
export class TransloaditConfigError extends Error {
  constructor(varName: string) {
    super(`${varName} is not configured.`);
    this.name = "TransloaditConfigError";
  }
}

function authKey(): string {
  const key = process.env.TRANSLOADIT_AUTH_KEY;
  if (!key) {
    throw new TransloaditConfigError("TRANSLOADIT_AUTH_KEY");
  }
  return key;
}

function authSecret(): string {
  const secret = process.env.TRANSLOADIT_AUTH_SECRET;
  if (!secret) {
    throw new TransloaditConfigError("TRANSLOADIT_AUTH_SECRET");
  }
  return secret;
}

export interface TransloaditAuthBlock {
  key: string;
  expires: string;
  nonce: string;
}

/**
 * Builds the `auth` block for a signed Assembly request. `expires` is ISO
 * 8601 UTC (`toISOString()`'s millisecond-inclusive form is accepted by
 * Transloadit's API alongside the second-precision form their docs show).
 * `nonce` is a fresh random string per call — Transloadit's documented
 * replay/duplicate-processing guard.
 */
export function buildAuthBlock(ttlMs: number = TRANSLOADIT_ASSEMBLY_SIGN_TTL_MS): TransloaditAuthBlock {
  return {
    key: authKey(),
    expires: new Date(Date.now() + ttlMs).toISOString(),
    nonce: randomUUID(),
  };
}

export interface SignedParams {
  params: string;
  signature: string;
}

/**
 * Serializes `params` exactly once and signs that exact JSON string with
 * HMAC-SHA384. Both the string and the signature must be sent verbatim —
 * re-serializing the object again before sending would produce a
 * byte-for-byte different string and the signature would not match.
 */
export function signParams(params: Record<string, unknown>): SignedParams {
  const secret = authSecret();
  const jsonString = JSON.stringify(params);
  const hexDigest = createHmac("sha384", secret).update(jsonString).digest("hex");
  return { params: jsonString, signature: `sha384:${hexDigest}` };
}
