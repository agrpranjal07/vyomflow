/**
 * Generated-asset ingestion (S7): moves a media tool's raw result URLs
 * into durable S3-backed storage via the `s3-generated-asset-ingest`
 * Template. Exception-safe by design — this function must never throw,
 * since its caller (src/trigger/tool.ts, the media-tool-completion path)
 * must not have a Transloadit failure misreported as a media-tool
 * failure. Ingestion durability is a secondary property: any failure falls
 * back to the original result URLs so the user still sees their asset.
 */
import { createAssembly, awaitAssembly } from "./client";
import { TRANSLOADIT_INGEST_TEMPLATE_ID } from "@/lib/config";

export type IngestStatus = "INGESTED" | "FAILED" | "SKIPPED";

export interface IngestGeneratedAssetsResult {
  resultUrls: string[];
  sourceUrls: string[];
  ingestStatus: IngestStatus;
  // Only set when there was exactly one source URL (one Assembly). With
  // multiple URLs there are multiple Assemblies per invocation — storing
  // just the last one would misleadingly imply a single Assembly covers
  // them all, so this stays null and callers rely on sourceUrls/resultUrls.
  assemblyId: string | null;
}

export interface IngestGeneratedAssetsOpts {
  ownerId: string;
  assetId: string;
}

async function ingestOne(sourceUrl: string, opts: IngestGeneratedAssetsOpts): Promise<{ resultUrl: string; assemblyId: string }> {
  const { assemblyId, statusUrl } = await createAssembly({
    templateId: TRANSLOADIT_INGEST_TEMPLATE_ID,
    fields: { source_url: sourceUrl, ownerId: opts.ownerId, assetId: opts.assetId },
  });
  const status = await awaitAssembly(statusUrl);
  if (!status.ok || !status.resultUrl) {
    throw new Error(`Transloadit ingest did not complete successfully (rawStatus: ${status.rawStatus}).`);
  }
  return { resultUrl: status.resultUrl, assemblyId };
}

/**
 * Ingests every URL in `urls` into durable storage. Succeeds only if ALL
 * urls ingest — any single failure (thrown error, timeout, or a
 * non-`ok` terminal status) falls the whole call back to the original
 * result URLs rather than a partially-ingested mix.
 */
export async function ingestGeneratedAssets(
  urls: string[],
  opts: IngestGeneratedAssetsOpts,
): Promise<IngestGeneratedAssetsResult> {
  if (urls.length === 0) {
    return { resultUrls: [], sourceUrls: [], ingestStatus: "SKIPPED", assemblyId: null };
  }

  try {
    const ingested = await Promise.all(urls.map((url) => ingestOne(url, opts)));
    return {
      resultUrls: ingested.map((r) => r.resultUrl),
      sourceUrls: urls,
      ingestStatus: "INGESTED",
      assemblyId: ingested.length === 1 ? ingested[0].assemblyId : null,
    };
  } catch (error) {
    console.error(
      `[transloadit-ingest] ingestion failed for ownerId=${opts.ownerId} assetId=${opts.assetId} urlCount=${urls.length}`,
      error,
    );
    return { resultUrls: urls, sourceUrls: urls, ingestStatus: "FAILED", assemblyId: null };
  }
}
