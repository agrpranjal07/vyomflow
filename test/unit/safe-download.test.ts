import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises lib/safe-download.ts's own SSRF logic directly (DNS resolution,
// private/reserved-range rejection for IPv4/IPv6 including embedded-v4,
// redirect re-validation, scheme rejection, connection pinning, byte-cap
// enforcement) — the adapter-level tests (crop-image/generate-image/
// merge-videos) mock this module away entirely, so this suite is the only
// place that logic is actually verified.
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));
vi.mock("node:http", () => ({ request: httpRequestMock }));
vi.mock("node:https", () => ({ request: httpsRequestMock }));

import { openSafeStream, safeDownloadToBuffer, safeDownloadToFile, UnsafeUrlError, SafeDownloadError } from "@/lib/safe-download";

afterEach(() => {
  lookupMock.mockReset();
  httpRequestMock.mockReset();
  httpsRequestMock.mockReset();
});

function ctlSignal() {
  return new AbortController().signal;
}

/** A fake response: a real Readable (so both async-iteration and .on('data'/'end') work, same as node:http's IncomingMessage) plus statusCode/headers. */
function makeResponse(
  chunks: Buffer[],
  opts: { statusCode?: number; headers?: Record<string, string> } = {},
): Readable & { statusCode: number; headers: Record<string, string> } {
  const stream = Readable.from(chunks.length ? chunks : [Buffer.alloc(0)]) as Readable & {
    statusCode: number;
    headers: Record<string, string>;
  };
  stream.statusCode = opts.statusCode ?? 200;
  stream.headers = opts.headers ?? {};
  return stream;
}

/** Queues one response (or a request-level error) on the given transport mock, and returns the captured request options. */
function mockOneRequest(
  requestMock: typeof httpRequestMock,
  outcome: { response: ReturnType<typeof makeResponse> } | { error: Error },
): { options: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined;
  requestMock.mockImplementationOnce((options: Record<string, unknown>, callback: (res: unknown) => void) => {
    captured = options;
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = vi.fn();
    if ("error" in outcome) {
      queueMicrotask(() => req.emit("error", outcome.error));
    } else {
      queueMicrotask(() => callback(outcome.response));
    }
    return req;
  });
  return { options: () => captured! };
}

function resolvesTo(...records: Array<{ address: string; family: 4 | 6 }>) {
  lookupMock.mockResolvedValueOnce(records);
}

describe("safe-download: scheme and URL validation", () => {
  it("rejects a non-http(s) scheme", async () => {
    await expect(openSafeStream("ftp://example.com/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL", async () => {
    await expect(openSafeStream("not a url at all", { signal: ctlSignal() })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("wraps a DNS resolution failure as SafeDownloadError (not UnsafeUrlError)", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(openSafeStream("https://nowhere.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      SafeDownloadError,
    );
  });

  it("rejects a hostname that resolves to zero addresses", async () => {
    resolvesTo();
    await expect(openSafeStream("https://empty.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("safe-download: IPv4 private/reserved-range rejection", () => {
  const cases: Array<[string, string]> = [
    ["0.0.0.0", "0.0.0.0/8"],
    ["10.1.2.3", "10.0.0.0/8"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["172.16.0.1", "172.16.0.0/12"],
    ["192.168.1.1", "192.168.0.0/16"],
    ["100.64.0.1", "CGNAT 100.64.0.0/10"],
    ["192.0.0.1", "192.0.0.0/24 IETF protocol assignments"],
    ["198.18.0.1", "benchmarking 198.18.0.0/15"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast/reserved"],
  ];

  it.each(cases)("rejects %s (%s) without ever issuing a request", async (address) => {
    resolvesTo({ address, family: 4 });
    await expect(openSafeStream("https://target.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("accepts a public IPv4 address (203.0.113.0/24 TEST-NET-3, used as the fixture 'public' address throughout this suite)", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const { options } = mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("ok")]) });
    const buf = await safeDownloadToBuffer("https://target.example/x", { maxBytes: 100, signal: ctlSignal() });
    expect(buf.toString()).toBe("ok");
    expect(options().hostname).toBe("203.0.113.10");
  });
});

describe("safe-download: IPv6 private/reserved-range rejection", () => {
  const cases: Array<[string, string]> = [
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique local fc00::/7"],
    ["fd12:3456::1", "unique local fc00::/7"],
    ["fe80::1", "link-local fe80::/10"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped cloud metadata"],
  ];

  it.each(cases)("rejects %s (%s)", async (address) => {
    resolvesTo({ address, family: 6 });
    await expect(openSafeStream("https://target.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("accepts a public IPv6 address", async () => {
    resolvesTo({ address: "2001:db8::1", family: 6 });
    mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("ok")]) });
    const buf = await safeDownloadToBuffer("https://target.example/x", { maxBytes: 100, signal: ctlSignal() });
    expect(buf.toString()).toBe("ok");
  });
});

describe("safe-download: multi-record and connection-pinning behavior", () => {
  it("rejects if ANY resolved address is disallowed, even when another is public", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 });
    await expect(openSafeStream("https://target.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("pins the connection to the validated address while preserving the original Host header and TLS servername", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const { options } = mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("x")]) });

    await safeDownloadToBuffer("https://real-host.example/some/path?q=1", { maxBytes: 10, signal: ctlSignal() });

    const opts = options();
    expect(opts.hostname).toBe("203.0.113.10");
    expect(opts.path).toBe("/some/path?q=1");
    expect((opts.headers as Record<string, string>).host).toBe("real-host.example");
    expect(opts.servername).toBe("real-host.example");
    expect(opts.port).toBe(443);
  });

  it("uses node:http (not node:https) for http: URLs, and sets no TLS servername", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const { options } = mockOneRequest(httpRequestMock, { response: makeResponse([Buffer.from("x")]) });

    await safeDownloadToBuffer("http://real-host.example/x", { maxBytes: 10, signal: ctlSignal() });

    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(options().servername).toBeUndefined();
    expect(options().port).toBe(80);
  });

  it("respects an explicit port in the URL", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const { options } = mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("x")]) });

    await safeDownloadToBuffer("https://real-host.example:8443/x", { maxBytes: 10, signal: ctlSignal() });

    expect(options().port).toBe(8443);
  });

  it("surfaces a request-level transport error as SafeDownloadError", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, { error: new Error("ECONNREFUSED") });

    await expect(openSafeStream("https://target.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      SafeDownloadError,
    );
  });
});

describe("safe-download: redirects", () => {
  it("follows a redirect and re-validates the new host's DNS before connecting", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 }); // hop 1: target.example
    mockOneRequest(httpsRequestMock, {
      response: makeResponse([], { statusCode: 302, headers: { location: "https://redirected.example/final" } }),
    });
    resolvesTo({ address: "203.0.113.20", family: 4 }); // hop 2: redirected.example
    const { options } = mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("final-body")]) });

    const buf = await safeDownloadToBuffer("https://target.example/start", { maxBytes: 100, signal: ctlSignal() });

    expect(buf.toString()).toBe("final-body");
    expect(options().hostname).toBe("203.0.113.20");
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it("rejects when a redirect target resolves to a private address — a public URL cannot 302 into private space", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 }); // hop 1: public
    mockOneRequest(httpsRequestMock, {
      response: makeResponse([], { statusCode: 302, headers: { location: "https://internal.example/secret" } }),
    });
    resolvesTo({ address: "10.0.0.5", family: 4 }); // hop 2: private — must still be caught

    await expect(openSafeStream("https://target.example/start", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("caps redirect chains and fails closed rather than looping forever", async () => {
    // 7 redirects in a row, one more than MAX_REDIRECTS (5).
    for (let i = 0; i < 7; i++) {
      resolvesTo({ address: "203.0.113.10", family: 4 });
      mockOneRequest(httpsRequestMock, {
        response: makeResponse([], { statusCode: 302, headers: { location: `https://target.example/hop-${i + 1}` } }),
      });
    }

    await expect(openSafeStream("https://target.example/start", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      SafeDownloadError,
    );
  });

  it("resolves a relative redirect Location against the current URL", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, {
      response: makeResponse([], { statusCode: 302, headers: { location: "/elsewhere" } }),
    });
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const { options } = mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("ok")]) });

    await safeDownloadToBuffer("https://target.example/start", { maxBytes: 10, signal: ctlSignal() });

    expect(options().path).toBe("/elsewhere");
  });
});

describe("safe-download: HTTP status handling", () => {
  it("rejects a non-2xx response with SafeDownloadError", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, { response: makeResponse([], { statusCode: 404 }) });

    await expect(openSafeStream("https://target.example/x", { signal: ctlSignal() })).rejects.toBeInstanceOf(
      SafeDownloadError,
    );
  });
});

describe("safe-download: byte-cap enforcement", () => {
  it("caps bytes as they arrive, not after buffering the full body", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    const chunks = [Buffer.alloc(50, "a"), Buffer.alloc(50, "b"), Buffer.alloc(50, "c")];
    mockOneRequest(httpsRequestMock, { response: makeResponse(chunks) });

    await expect(
      safeDownloadToBuffer("https://target.example/x", { maxBytes: 80, signal: ctlSignal() }),
    ).rejects.toBeInstanceOf(SafeDownloadError);
  });

  it("returns the exact concatenated bytes when the body is within the cap", async () => {
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("hello "), Buffer.from("world")]) });

    const buf = await safeDownloadToBuffer("https://target.example/x", { maxBytes: 100, signal: ctlSignal() });

    expect(buf.toString()).toBe("hello world");
  });
});

describe("safe-download: safeDownloadToFile", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("streams a within-cap body to disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-download-test-"));
    const destPath = join(dir, "out.bin");
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, { response: makeResponse([Buffer.from("file-body")]) });

    await safeDownloadToFile("https://target.example/x", destPath, { maxBytes: 100, signal: ctlSignal() });

    const written = await readFile(destPath);
    expect(written.toString()).toBe("file-body");
  });

  it("rejects and stops writing once the byte cap is exceeded", async () => {
    dir = await mkdtemp(join(tmpdir(), "safe-download-test-"));
    const destPath = join(dir, "out.bin");
    resolvesTo({ address: "203.0.113.10", family: 4 });
    mockOneRequest(httpsRequestMock, {
      response: makeResponse([Buffer.alloc(50, "a"), Buffer.alloc(50, "b")]),
    });

    await expect(
      safeDownloadToFile("https://target.example/x", destPath, { maxBytes: 60, signal: ctlSignal() }),
    ).rejects.toBeInstanceOf(SafeDownloadError);
  });
});
