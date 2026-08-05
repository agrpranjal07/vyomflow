/**
 * S4 — signed direct-upload Assembly params for user attachments. Distinct
 * from ../ingest.ts (which fetches an already-generated remote URL
 * server-side via /http/import): this path signs params for a *client-
 * driven* tus upload through @uppy/transloadit, against
 * TRANSLOADIT_UPLOAD_TEMPLATE_ID (reserved out-of-band for this slice,
 * unused by S7 ingestion). Reuses buildAuthBlock/signParams from
 * ./signing.ts unmodified — same signing scheme already proven live by S7.
 *
 * One Assembly per file, not per upload batch: @uppy/transloadit's
 * documented default processes every file added to one uppy.upload() call
 * in a single shared Assembly (Context7, uppy.io/docs/transloadit, "All
 * files are processed in a single assembly"). To keep cancel/retry/
 * per-file failure independent (assignment: "Support ... progress,
 * cancellation, retry ... stable attachment order"), the frontend must
 * issue one uppy.upload() call per file, each using that file's own
 * Attachment row's signed params from requestUploadParamsBatch below —
 * never a single batched upload covering multiple Attachment rows.
 */
import { openAsBlob } from "node:fs";
import { buildAuthBlock, signParams } from "./signing";
import { TRANSLOADIT_UPLOAD_TEMPLATE_ID, TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID, TRANSLOADIT_API_BASE_URL, TRANSLOADIT_REQUEST_TIMEOUT_MS } from "@/lib/config";
import { MAX_ATTACHMENT_BYTES } from "@/contracts/attachments";
import { awaitAssembly, TransloaditRequestError } from "./client";
import type { MediaArtifact } from "@/server/tools/registry";

export interface SignedUploadAssemblyParams {
  params: string;
  signature: string;
}

/**
 * Signs one Assembly request for a single attachment's direct upload.
 * `fields` are available in the Template's steps via `${fields.X}`
 * substitution (recon-findings.md) — used to namespace the destination
 * path by owner/attachment id, same mechanism ../ingest.ts already relies
 * on for its own Template.
 */
export function signUploadAssemblyParams(fields: Record<string, string>): SignedUploadAssemblyParams {
  const auth = buildAuthBlock();
  // Since allow_steps_override:false forbids sending inline steps, the
  // per-file size cap can only reach the Template via `${fields.max_size}`
  // substitution (same mechanism as the ownerId/attachmentId fields above) —
  // not a top-level Assembly param. This caps the actual upload server-side,
  // not just the client-declared byteSize validated at request time.
  const fieldsWithLimit = { ...fields, max_size: String(MAX_ATTACHMENT_BYTES) };
  return signParams({ auth, template_id: TRANSLOADIT_UPLOAD_TEMPLATE_ID, fields: fieldsWithLimit });
}

// ---------------------------------------------------------------------------
// VyomFlow Task 3.1 — direct buffer/file-stream upload of locally-produced
// media artifacts (crop_image/generate_image/merge_videos output), against
// TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID's `:original` step. Distinct from
// both helpers above: signUploadAssemblyParams only *signs* params for a
// client-driven tus upload (no bytes ever touch this server); ../ingest.ts's
// ingestGeneratedAssets fetches an already-public URL server-side via
// /http/import (no bytes touch this server either). This is the one path
// where our own process actually attaches file bytes to a multipart POST —
// required because a locally-produced `bytes`/`file` artifact has no URL a
// remote /http/import could fetch.
// ---------------------------------------------------------------------------

export interface UploadGeneratedArtifactsOpts {
  ownerId: string;
  assetId: string;
}

export interface UploadGeneratedArtifactsResult {
  resultUrls: string[];
  /** Always empty — there is no source URL for locally-produced bytes, unlike ../ingest.ts's sourceUrls. Documented reliability difference: see this function's own doc comment. */
  sourceUrls: string[];
  ingestStatus: "INGESTED" | "FAILED";
  assemblyId: string | null;
}

/**
 * One Assembly per artifact, not one batched multi-file Assembly — a
 * deliberate deviation from the literal "one file field per artifact [in
 * one Assembly]" reading of the plan, found necessary while implementing
 * this: `awaitAssembly` (client.ts) resolves a completed Assembly's result
 * to a SINGLE `resultUrl` by indexing `[0]` into whichever step's `results`
 * array it finds — correct for the existing one-file-per-Assembly ingest
 * path, but it would silently keep only the first file's URL and drop every
 * other artifact's URL for a multi-file Assembly (e.g. generate_image's
 * `n>1`, which really does produce multiple `bytes` artifacts in one
 * `MediaToolResult`). Since the task explicitly requires reusing
 * `awaitAssembly` completely unchanged, one-Assembly-per-artifact is the
 * only structure that stays correct for every artifact count without
 * touching it — same Promise.all-many-Assemblies shape `ingestGeneratedAssets`
 * (../ingest.ts) already uses for its own multi-URL case, including its
 * assemblyId convention (returned only when there was exactly one artifact,
 * else null, since multiple Assemblies have no single id to report).
 */
async function uploadOne(
  artifact: MediaArtifact,
  fieldName: string,
  opts: UploadGeneratedArtifactsOpts,
  signal?: AbortSignal,
): Promise<{ resultUrl: string; assemblyId: string }> {
  if (artifact.kind === "url") {
    throw new Error(
      "uploadGeneratedArtifacts: received a \"url\" artifact — this path never handles url artifacts, the caller must route them through ingestGeneratedAssets instead.",
    );
  }

  const auth = buildAuthBlock();
  const signed = signParams({
    auth,
    template_id: TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID,
    fields: { ownerId: opts.ownerId, assetId: opts.assetId },
  });

  const form = new FormData();
  form.set("params", signed.params);
  form.set("signature", signed.signature);

  if (artifact.kind === "bytes") {
    form.set(fieldName, new Blob([artifact.body as BlobPart], { type: artifact.contentType }), artifact.filename);
  } else {
    // Streamed from disk via node:fs's openAsBlob — never buffered fully
    // into memory (plan B5). Confirmed stable (not merely present as an
    // experimental symbol) on this project's installed Node 20.20.0 by a
    // real read-back during Task 3.1 development — see this phase's report.
    const blob = await openAsBlob(artifact.path, { type: artifact.contentType });
    form.set(fieldName, blob, artifact.filename);
  }

  const response = await fetch(`${TRANSLOADIT_API_BASE_URL}/assemblies`, {
    method: "POST",
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TRANSLOADIT_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(TRANSLOADIT_REQUEST_TIMEOUT_MS),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const record = body as Record<string, unknown> | undefined;
    const message =
      (record && typeof record.error === "string" && record.error) ||
      (record && typeof record.message === "string" && record.message) ||
      `Transloadit Assembly creation failed with status ${response.status}.`;
    throw new TransloaditRequestError(response.status, message);
  }

  // Mirrors createAssembly's own response-parsing comment (client.ts) —
  // POST /assemblies returns the full Assembly status object immediately,
  // with the pollable status URL under assembly_ssl_url (falling back to
  // assembly_url).
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

  const status = await awaitAssembly(statusUrl, signal);
  if (!status.ok || !status.resultUrl) {
    throw new Error(`uploadGeneratedArtifacts: Assembly did not complete successfully (rawStatus: ${status.rawStatus}).`);
  }

  return { resultUrl: status.resultUrl, assemblyId };
}

/**
 * Uploads every artifact directly (multipart file upload, one Assembly per
 * artifact — see `uploadOne`'s comment for why not one batched Assembly) to
 * TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID's `:original` step, reusing
 * `awaitAssembly` completely unchanged (identical to ../ingest.ts's poll
 * path) for each one. Runs concurrently via `Promise.all` — safe since each
 * artifact's Assembly is fully independent.
 *
 * **Failure-signaling convention (deliberate, load-bearing for Task 3.2):
 * this function THROWS on any failure** — network error, non-2xx response,
 * a malformed Assembly-creation response, or `awaitAssembly` reporting
 * `ok: false`/timing out for ANY one artifact fails the whole call. Unlike
 * `ingestGeneratedAssets` (which never throws and falls back to the raw
 * source URL), there is no raw-URL fallback available here: a
 * locally-produced `bytes`/`file` artifact only exists in `ctx.workDir`,
 * which is deleted the moment `tool.ts`'s `finally` block runs — so a
 * Transloadit outage on this path must surface as a hard tool failure,
 * never a silently-degraded COMPLETED. The caller (`src/trigger/tool.ts`)
 * is responsible for catching this and settling the invocation FAILED with
 * `errorCode: "asset_upload_failed"`.
 *
 * `artifact.kind === "url"` is not handled here — the caller routes `url`
 * artifacts through the existing `ingestGeneratedAssets` instead. Passing
 * one here is a caller bug, not an expected path (see `uploadOne`).
 */
export async function uploadGeneratedArtifacts(
  artifacts: MediaArtifact[],
  opts: UploadGeneratedArtifactsOpts,
  signal?: AbortSignal,
): Promise<UploadGeneratedArtifactsResult> {
  const uploaded = await Promise.all(artifacts.map((artifact, i) => uploadOne(artifact, `file-${i}`, opts, signal)));
  return {
    resultUrls: uploaded.map((r) => r.resultUrl),
    sourceUrls: [],
    ingestStatus: "INGESTED",
    assemblyId: uploaded.length === 1 ? uploaded[0].assemblyId : null,
  };
}
