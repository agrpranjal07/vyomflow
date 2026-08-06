/**
 * SSRF-safe downloader for the three media-tool adapters' user-URL fetches
 * (crop_image's image_url, merge_videos' video_urls, generate_image's
 * reference images). None of these should ever reach the process's own
 * network segment or a cloud metadata endpoint, even though the URL itself
 * comes from an allowlisted, user-typed source (turn.ts's
 * getAllowedAssetUrls trusts the account holder's own chat text — this
 * module is the egress control that's independent of that trust decision).
 *
 * Design, in order:
 *   1. scheme allowlist (http/https only)
 *   2. DNS-resolve the hostname to every A/AAAA record, reject if ANY of
 *      them is private/reserved/loopback/link-local/metadata-range —
 *      defeats a multi-record bypass, not just the first address
 *   3. issue the request over node:http(s) with a custom `lookup` that
 *      returns the address already validated in step 2 — this pins the
 *      TCP connection to that exact address, closing the DNS-rebinding
 *      window between validation and connect that a plain `fetch()` can't
 *      close (fetch has no hook to pin the resolved address)
 *   4. redirects are followed manually, capped, and re-validated at every
 *      hop from step 1 — a public URL can't 302 into private space
 *   5. response bytes are capped as they arrive, never buffered-then-checked
 *
 * No new dependency: node:http/node:https/node:dns only.
 */
import { request as httpRequestRaw, type IncomingMessage } from "node:http";
import { request as httpsRequestRaw } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { MEDIA_SOURCE_DOWNLOAD_BUDGET_MS } from "@/lib/config";

/** The destination was rejected on safety grounds — never retryable by construction. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** A genuine network/transport failure (timeout, refused, size cap, non-2xx) — retryable-shaped. */
export class SafeDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeDownloadError";
  }
}

const MAX_REDIRECTS = 5;

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed -> reject
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments (parts[2] not checked further, whole /16 is reserved-adjacent — conservative)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  const v4Embedded = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Embedded) return isPrivateOrReservedIPv4(v4Embedded[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local (covers fd00:ec2::254-style metadata too, via fc00::/7 above for AWS's actual fd00::/8 range)
  return false;
}

function isDisallowedAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateOrReservedIPv4(address) : isPrivateOrReservedIPv6(address);
}

interface ValidatedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Parses, scheme-checks, and DNS-resolves+validates one URL — no request made yet. */
async function validateTarget(rawUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("The referenced URL could not be parsed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http(s) URLs are allowed.");
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeDownloadError("The referenced host could not be resolved.");
  }
  if (records.length === 0) {
    throw new UnsafeUrlError("The referenced host did not resolve to any address.");
  }
  // Reject if ANY resolved address is disallowed — a multi-A-record host
  // that resolves to one public and one private address is still rejected;
  // never trust the caller to always hit the "safe" one.
  for (const record of records) {
    if (isDisallowedAddress(record.address, record.family as 4 | 6)) {
      throw new UnsafeUrlError("The referenced URL resolves to a disallowed address.");
    }
  }
  const chosen = records[0];
  return { url, address: chosen.address, family: chosen.family as 4 | 6 };
}

interface OpenStreamOptions {
  signal: AbortSignal;
  redirectsLeft?: number;
}

/**
 * Validates and opens the response stream for one URL, following redirects
 * manually (re-validating scheme + DNS at every hop). Caller owns consuming
 * or destroying the returned stream. Exported (not just used internally by
 * safeDownloadToBuffer/safeDownloadToFile below) for merge-videos.ts, which
 * needs this validated stream but has its own two-tier per-file/aggregate
 * byte-budget Transform to preserve rather than the single-cap helpers here.
 */
export async function openSafeStream(rawUrl: string, opts: OpenStreamOptions): Promise<IncomingMessage> {
  const redirectsLeft = opts.redirectsLeft ?? MAX_REDIRECTS;
  const target = await validateTarget(rawUrl);
  const requestFn = target.url.protocol === "https:" ? httpsRequestRaw : httpRequestRaw;
  const combinedSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(MEDIA_SOURCE_DOWNLOAD_BUDGET_MS)]);

  const port = target.url.port ? Number(target.url.port) : target.url.protocol === "https:" ? 443 : 80;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = requestFn(
      {
        // Pins the TCP connection to the address already validated above —
        // this is the whole reason node:http(s) is used instead of fetch,
        // which has no hook to override DNS resolution per-request. The
        // Host header (and, for TLS, `servername` for SNI/cert validation)
        // are kept as the original hostname so the request still reaches
        // the right virtual host and TLS still validates against the name
        // the caller actually asked for.
        hostname: target.address,
        port,
        path: `${target.url.pathname}${target.url.search}`,
        headers: { host: target.url.host },
        servername: target.url.protocol === "https:" ? target.url.hostname : undefined,
        signal: combinedSignal,
      },
      (res) => resolve(res),
    );
    req.on("error", (err) => reject(new SafeDownloadError(`Request failed: ${(err as Error).message}`)));
    req.end();
  });

  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location) {
    const location = response.headers.location;
    response.resume(); // drain and discard the redirect body
    if (redirectsLeft <= 0) {
      throw new SafeDownloadError("Too many redirects.");
    }
    const nextUrl = new URL(location, target.url).toString();
    return openSafeStream(nextUrl, { signal: opts.signal, redirectsLeft: redirectsLeft - 1 });
  }
  if (status < 200 || status >= 300) {
    response.resume();
    throw new SafeDownloadError(`Request returned HTTP ${status}.`);
  }
  return response;
}

export interface SafeDownloadOptions {
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * Downloads a URL into memory, capping bytes as they arrive (never
 * buffer-then-check) — for the crop_image source image and generate_image's
 * reference images, both of which need a whole in-memory buffer for sharp.
 */
export async function safeDownloadToBuffer(rawUrl: string, opts: SafeDownloadOptions): Promise<Buffer> {
  const response = await openSafeStream(rawUrl, { signal: opts.signal });
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      received += chunk.length;
      if (received > opts.maxBytes) {
        response.destroy();
        throw new SafeDownloadError(`Downloaded body exceeds the ${opts.maxBytes}-byte cap.`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof SafeDownloadError) throw err;
    throw new SafeDownloadError(`Download stream failed: ${(err as Error).message}`);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a URL to a file on disk, capping bytes as they arrive — for
 * merge_videos' input clips (streamed to /tmp, never fully buffered in the
 * JS heap).
 */
export async function safeDownloadToFile(rawUrl: string, destPath: string, opts: SafeDownloadOptions): Promise<void> {
  const response = await openSafeStream(rawUrl, { signal: opts.signal });
  const dest = createWriteStream(destPath);
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > opts.maxBytes) {
        response.destroy();
        dest.destroy();
        reject(new SafeDownloadError(`Downloaded body exceeds the ${opts.maxBytes}-byte cap.`));
        return;
      }
      dest.write(chunk);
    });
    response.on("end", () => dest.end(resolve));
    response.on("error", (err) => {
      dest.destroy();
      reject(new SafeDownloadError(`Download stream failed: ${(err as Error).message}`));
    });
    dest.on("error", (err) => reject(new SafeDownloadError(`Write failed: ${(err as Error).message}`)));
  });
}
