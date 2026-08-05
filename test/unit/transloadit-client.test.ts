import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from "vitest";
import { createAssembly, awaitAssembly, TransloaditRequestError } from "@/server/transloadit/client";
import { TRANSLOADIT_API_BASE_URL } from "@/lib/config";

const server = setupServer();

const ORIGINAL_KEY = process.env.TRANSLOADIT_AUTH_KEY;
const ORIGINAL_SECRET = process.env.TRANSLOADIT_AUTH_SECRET;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  process.env.TRANSLOADIT_AUTH_KEY = "test_auth_key";
  process.env.TRANSLOADIT_AUTH_SECRET = "test-secret";
});

/**
 * Regression coverage for a real bug found during live verification
 * (2026-08-21): POST /assemblies does NOT return a slim {assembly_id, url}
 * envelope — it returns the full Assembly status object immediately, and
 * the pollable-status field is `assembly_ssl_url` (or `assembly_url`),
 * never `url`. The original implementation checked for a `url` field that
 * never exists on a real response, so every real Assembly creation was
 * rejected as malformed and silently fell back to the original source URL
 * — passing every mocked test (whose fixtures encoded the same wrong
 * shape) while being completely broken end to end.
 */
describe("createAssembly — real response-shape parsing", () => {
  it("parses a realistic full Assembly-status response (assembly_ssl_url, not url)", async () => {
    server.use(
      http.post(`${TRANSLOADIT_API_BASE_URL}/assemblies`, () =>
        HttpResponse.json({
          ok: "ASSEMBLY_EXECUTING",
          assembly_id: "bfd5a0a1b9a442a9904c70aaacff651b",
          assembly_url: "http://api2.hu523ap.transloadit.com/assemblies/bfd5a0a1b9a442a9904c70aaacff651b",
          assembly_ssl_url: "https://api2-hu523ap.transloadit.com/assemblies/bfd5a0a1b9a442a9904c70aaacff651b",
          template_id: "050c3ae0e2cf423a9cf7dc7f5d8eb808",
          results: {},
          fields: { source_url: "https://example.com/a.png" },
        }),
      ),
    );

    const result = await createAssembly({ templateId: "t", fields: { source_url: "https://example.com/a.png" } });
    expect(result.assemblyId).toBe("bfd5a0a1b9a442a9904c70aaacff651b");
    expect(result.statusUrl).toBe("https://api2-hu523ap.transloadit.com/assemblies/bfd5a0a1b9a442a9904c70aaacff651b");
  });

  it("falls back to assembly_url when assembly_ssl_url is absent", async () => {
    server.use(
      http.post(`${TRANSLOADIT_API_BASE_URL}/assemblies`, () =>
        HttpResponse.json({ assembly_id: "asm_1", assembly_url: "http://example.transloadit.com/assemblies/asm_1" }),
      ),
    );

    const result = await createAssembly({ templateId: "t", fields: {} });
    expect(result.statusUrl).toBe("http://example.transloadit.com/assemblies/asm_1");
  });

  it("throws TransloaditRequestError when neither assembly_ssl_url nor assembly_url is present", async () => {
    server.use(http.post(`${TRANSLOADIT_API_BASE_URL}/assemblies`, () => HttpResponse.json({ assembly_id: "asm_1" })));

    await expect(createAssembly({ templateId: "t", fields: {} })).rejects.toThrow(TransloaditRequestError);
  });
});

/**
 * Regression coverage for a second real bug found during live verification
 * (2026-08-21): the `/cloudflare/store` robot (both real Templates were
 * switched to this from a generic `/s3/store` after that failed with
 * S3_STORE_ACCESS_DENIED against the R2 credential) does not add its own
 * named entry to `results` — it mutates the UPSTREAM step's file object in
 * place, so the R2 `ssl_url` surfaces under the step that fed the storage
 * step ("imported" for the real ingest Template), never under the storage
 * step's own name ("stored"). The original lookup was hardcoded to
 * `results.stored[0].ssl_url` and always found nothing on a real Assembly,
 * silently ingesting nothing while still reporting `ok: true`.
 */
describe("awaitAssembly — result-URL lookup is robust to which step name Transloadit uses", () => {
  const STATUS_URL = "https://api2-euwest.transloadit.com/assemblies/asm_x";

  it("finds the result under the configured step name when present", async () => {
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json({ ok: "ASSEMBLY_COMPLETED", results: { stored: [{ ssl_url: "https://r2.example.com/a.jpg" }] } }),
      ),
    );
    const result = await awaitAssembly(STATUS_URL);
    expect(result.ok).toBe(true);
    expect(result.resultUrl).toBe("https://r2.example.com/a.jpg");
    expect(result.rawStatus).toBe("ASSEMBLY_COMPLETED");
  });

  it("falls back to whichever step actually produced a result (real /cloudflare/store shape: keyed 'imported', not 'stored')", async () => {
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json({
          ok: "ASSEMBLY_COMPLETED",
          results: { imported: [{ ssl_url: "https://r2.example.com/generated/owner/asset/file.jpg" }] },
        }),
      ),
    );
    const result = await awaitAssembly(STATUS_URL);
    expect(result.ok).toBe(true);
    expect(result.resultUrl).toBe("https://r2.example.com/generated/owner/asset/file.jpg");
  });

  it("returns a null resultUrl when results is genuinely empty despite completion", async () => {
    server.use(http.get(STATUS_URL, () => HttpResponse.json({ ok: "ASSEMBLY_COMPLETED", results: {} })));
    const result = await awaitAssembly(STATUS_URL);
    expect(result.ok).toBe(true);
    expect(result.resultUrl).toBeNull();
    expect(result.rawStatus).toBe("ASSEMBLY_COMPLETED");
  });
});

/**
 * Bug fix (B): a non-retryable 4xx (bad/expired assembly id, malformed
 * request, etc., excluding 429) must fail fast with a single status fetch
 * rather than being treated as transient and retried until the whole poll
 * deadline elapses — a real 404/400 will never turn into success by
 * retrying, and burning the full ~60s deadline on it just delays a
 * completeAttachment call that should fail immediately. 429/5xx remain
 * transient and are still retried.
 */
describe("awaitAssembly — 4xx-vs-5xx classification (bug fix)", () => {
  const STATUS_URL = "https://api2-euwest.transloadit.com/assemblies/asm_class";

  it("fails fast (single fetch) on a non-retryable 4xx instead of polling until the deadline", async () => {
    let callCount = 0;
    server.use(
      http.get(STATUS_URL, () => {
        callCount += 1;
        return HttpResponse.json({ error: "ASSEMBLY_NOT_FOUND" }, { status: 404 });
      }),
    );

    await expect(awaitAssembly(STATUS_URL)).rejects.toThrow(TransloaditRequestError);
    expect(callCount).toBe(1);
  });

  it("does not fail fast on 429 — treats it as transient and keeps polling", async () => {
    let callCount = 0;
    server.use(
      http.get(STATUS_URL, () => {
        callCount += 1;
        if (callCount === 1) return HttpResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
        return HttpResponse.json({ ok: "ASSEMBLY_COMPLETED", results: { stored: [{ ssl_url: "https://r2.example.com/ok.png" }] } });
      }),
    );

    const result = await awaitAssembly(STATUS_URL);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2); // retried past the 429 rather than throwing
  });

  it("does not fail fast on a 5xx — treats it as transient and keeps polling until it recovers", async () => {
    let callCount = 0;
    server.use(
      http.get(STATUS_URL, () => {
        callCount += 1;
        if (callCount === 1) return HttpResponse.json({ error: "INTERNAL" }, { status: 500 });
        return HttpResponse.json({ ok: "ASSEMBLY_COMPLETED", results: { stored: [{ ssl_url: "https://r2.example.com/ok2.png" }] } });
      }),
    );

    const result = await awaitAssembly(STATUS_URL);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });
});
