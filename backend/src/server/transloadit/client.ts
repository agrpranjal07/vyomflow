/**
 * Transloadit Assembly client (S7 asset ingestion). Same pattern as the
 * codebase's other external-API clients: named error classes, bounded poll/backoff, no secret ever
 * reaches a thrown Error's `.message`.
 *
 * Both real Templates this integration uses have `allow_steps_override:
 * false` and require a valid signature — only `template_id` + `fields` are
 * ever sent as signed params, never inline `steps`.
 */
import {
  TRANSLOADIT_API_BASE_URL,
  TRANSLOADIT_POLL_INTERVAL_MS,
  TRANSLOADIT_POLL_DEADLINE_MS,
  TRANSLOADIT_REQUEST_TIMEOUT_MS,
  TRANSLOADIT_RESULT_STEP,
} from "@/lib/config";
import { buildAuthBlock, signParams } from "./signing";

export class TransloaditRequestError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "TransloaditRequestError";
    this.httpStatus = httpStatus;
  }
}

export class TransloaditTimeoutError extends Error {
  constructor(statusUrl: string) {
    super(`Assembly at ${statusUrl} did not reach a terminal state before the poll deadline.`);
    this.name = "TransloaditTimeoutError";
  }
}

/** Extracts a Transloadit-provided error message from a non-2xx response body, if present, without ever surfacing our own signature/secret. */
function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return undefined;
}

export interface CreateAssemblyParams {
  templateId: string;
  fields: Record<string, string>;
}

export interface CreateAssemblyResult {
  assemblyId: string;
  statusUrl: string;
}

/** POST /assemblies — dispatches a Template-driven Assembly with signed params. */
export async function createAssembly({ templateId, fields }: CreateAssemblyParams): Promise<CreateAssemblyResult> {
  const auth = buildAuthBlock();
  const signed = signParams({ auth, template_id: templateId, fields });

  const form = new FormData();
  form.set("params", signed.params);
  form.set("signature", signed.signature);

  const response = await fetch(`${TRANSLOADIT_API_BASE_URL}/assemblies`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TRANSLOADIT_REQUEST_TIMEOUT_MS),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new TransloaditRequestError(
      response.status,
      extractErrorMessage(body) ?? `Transloadit Assembly creation failed with status ${response.status}.`,
    );
  }

  // POST /assemblies returns the full Assembly status object immediately
  // (not a slim {assembly_id, url} envelope) — the field carrying the
  // pollable status URL is `assembly_ssl_url` (falling back to
  // `assembly_url` for a non-TLS instance region), verified against a real
  // response body during live verification 2026-08-21; an earlier
  // Context7-sourced doc example showed a simplified `{assembly_id, url}`
  // shape that does not match the live API and caused every real Assembly
  // creation to be rejected as "malformed" here.
  const record = body as Record<string, unknown> | null;
  const assemblyId = typeof record?.assembly_id === "string" ? record.assembly_id : undefined;
  const statusUrl =
    typeof record?.assembly_ssl_url === "string"
      ? record.assembly_ssl_url
      : typeof record?.assembly_url === "string"
        ? record.assembly_url
        : undefined;

  if (!assemblyId || !statusUrl) {
    throw new TransloaditRequestError(response.status, "Transloadit returned a malformed Assembly creation response.");
  }

  return { assemblyId, statusUrl };
}

export interface AwaitAssemblyResult {
  ok: boolean;
  resultUrl: string | null;
  rawStatus: string;
  /** Template fields echoed back on the Assembly status (e.g. attachmentId/ownerId) — used to verify the completed Assembly belongs to the caller. */
  fields: Record<string, unknown> | null;
  templateId: string | null;
  /** Actual bytes Transloadit received for the upload, per the Assembly status JSON's `bytes_received` — the source of truth over a client-declared byteSize. */
  bytesReceived: number | null;
}

/** Resolves early (never rejects) if `signal` aborts mid-sleep, so the poll loop's own `while` check runs sooner rather than waiting out the full interval. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// Substrings of a known terminal-failure `ok` value (Transloadit uses
// names like ASSEMBLY_CANCELLED/ASSEMBLY_CANCELED and REQUEST_ABORTED —
// docs don't enumerate every variant, so match conservatively on the
// unambiguous failure keywords rather than guessing the full enum).
const TERMINAL_FAILURE_KEYWORDS = ["CANCEL", "ABORT", "FAILED", "ERROR"];

/**
 * Polls an Assembly's status URL on a fixed interval until it reaches a
 * terminal state or the deadline elapses. `ok: "ASSEMBLY_COMPLETED"` is
 * success. A top-level `error` field, or an `ok` value matching a known
 * terminal-failure keyword, is treated as terminal failure. Any other
 * non-completed state (e.g. `"ASSEMBLY_UPLOADING"`, `"ASSEMBLY_EXECUTING"`)
 * keeps polling until the deadline, at which point a timeout is thrown
 * rather than guessed at as success or failure.
 */
export async function awaitAssembly(statusUrl: string, signal?: AbortSignal): Promise<AwaitAssemblyResult> {
  const deadline = Date.now() + TRANSLOADIT_POLL_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException("Transloadit polling was cancelled.", "AbortError");
    }
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TRANSLOADIT_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(TRANSLOADIT_REQUEST_TIMEOUT_MS);
    const response = await fetch(statusUrl, { method: "GET", signal: requestSignal });
    const body: unknown = await response.json().catch(() => undefined);

    // A non-retryable 4xx (bad/expired assembly id, malformed request, etc.,
    // excluding 429) will never succeed by retrying — fail fast rather than
    // burning the whole poll deadline. 429/5xx are transient and keep the
    // existing sleep-and-retry behavior below.
    if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new TransloaditRequestError(
        response.status,
        extractErrorMessage(body) ?? `Transloadit Assembly status check failed with status ${response.status}.`,
      );
    }

    if (response.ok && body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const okValue = typeof record.ok === "string" ? record.ok : undefined;
      const hasError = record.error !== undefined && record.error !== null;
      const rawStatus = okValue ?? String(record.error ?? "UNKNOWN");
      const fields = record.fields && typeof record.fields === "object" ? (record.fields as Record<string, unknown>) : null;
      const templateId = typeof record.template_id === "string" ? record.template_id : null;
      const bytesReceived = typeof record.bytes_received === "number" ? record.bytes_received : null;

      if (okValue === "ASSEMBLY_COMPLETED") {
        // `/cloudflare/store` (the real storage robot both Templates use —
        // switched from a generic `/s3/store` after that failed with
        // S3_STORE_ACCESS_DENIED against the R2 credential, verified
        // 2026-08-21) does not add its own named entry to `results` — it
        // mutates the UPSTREAM step's file object in place, so the R2 url
        // surfaces under the step that fed it (`imported` for the ingest
        // Template, `:original` for the upload Template), never under
        // TRANSLOADIT_RESULT_STEP ("stored") itself, confirmed against a
        // real Assembly response. Try the named step first in case a future
        // Template's storage robot does emit its own entry, then fall back
        // to whichever step actually produced a result — a completed
        // Assembly through either Template has exactly one.
        const results = record.results as Record<string, Array<{ ssl_url?: string }>> | undefined;
        const sslUrl =
          results?.[TRANSLOADIT_RESULT_STEP]?.[0]?.ssl_url ??
          (results ? Object.values(results)[0]?.[0]?.ssl_url : undefined) ??
          null;
        return { ok: true, resultUrl: sslUrl, rawStatus, fields, templateId, bytesReceived };
      }

      const matchesFailureKeyword = okValue !== undefined && TERMINAL_FAILURE_KEYWORDS.some((kw) => okValue.includes(kw));
      if (hasError || matchesFailureKeyword) {
        return { ok: false, resultUrl: null, rawStatus, fields, templateId, bytesReceived };
      }
    }

    await sleep(TRANSLOADIT_POLL_INTERVAL_MS, signal);
  }

  throw new TransloaditTimeoutError(statusUrl);
}
