import { describe, it, expect, afterEach, vi } from "vitest";
import sharp from "sharp";
import { TOOL_CREDIT_ESTIMATE } from "@/lib/config";

// crop-image.ts downloads via lib/safe-download.ts's safeDownloadToBuffer
// (SSRF-safe: DNS-resolves and validates the destination before any bytes
// move) rather than a bare global fetch — mocked here at the module
// boundary so these tests exercise crop-image.ts's own logic (rect
// resolution, sharp extract, error classification) without needing a real
// DNS-resolvable fixture host. lib/safe-download.ts's own SSRF validation
// logic (private-address rejection, redirect re-validation, etc.) is
// covered independently by unit/safe-download.test.ts.
const { safeDownloadToBuffer } = vi.hoisted(() => ({ safeDownloadToBuffer: vi.fn() }));
vi.mock("@/lib/safe-download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-download")>();
  return { ...actual, safeDownloadToBuffer };
});

import { cropImageTool, CropExtractError } from "@/server/tools/adapters/crop-image";
import { UnsafeUrlError, SafeDownloadError } from "@/lib/safe-download";

/** Small solid-color PNG fixture, generated in-process — no network, no fixture files. */
async function makeFixture(width: number, height: number): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function mockDownloadOnce(body: Uint8Array) {
  safeDownloadToBuffer.mockResolvedValueOnce(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
}

function ctx() {
  return {
    toolInvocationId: "ti_1",
    agentRunId: "ar_1",
    ownerId: "user_1",
    workDir: "/tmp/does-not-matter",
    signal: new AbortController().signal,
  };
}

// crop-image.ts must be a MediaToolFields adapter.
if (!("execute" in cropImageTool)) throw new Error("cropImageTool missing execute()");

describe("cropImageTool.execute", () => {
  afterEach(() => {
    safeDownloadToBuffer.mockReset();
  });

  it("crops percent-mode against real pixel dimensions", async () => {
    const fixture = await makeFixture(200, 100);
    mockDownloadOnce(fixture);

    const result = await cropImageTool.execute(
      {
        image_url: "https://example.com/a.png",
        x_percent: 25,
        y_percent: 0,
        width_percent: 50,
        height_percent: 100,
      },
      ctx(),
    );

    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0];
    if (artifact.kind !== "bytes") throw new Error("expected bytes artifact");
    const outMeta = await sharp(artifact.body).metadata();
    expect(outMeta.width).toBe(100); // 50% of 200
    expect(outMeta.height).toBe(100); // 100% of 100
  });

  it("crops pixel-mode exactly", async () => {
    const fixture = await makeFixture(200, 100);
    mockDownloadOnce(fixture);

    const result = await cropImageTool.execute(
      { image_url: "https://example.com/a.png", width_px: 60, height_px: 40, x_px: 10, y_px: 5 },
      ctx(),
    );

    const artifact = result.artifacts[0];
    if (artifact.kind !== "bytes") throw new Error("expected bytes artifact");
    const outMeta = await sharp(artifact.body).metadata();
    expect(outMeta.width).toBe(60);
    expect(outMeta.height).toBe(40);
  });

  it("centers the crop when x_px/y_px are omitted (contracts/tools.ts's documented default)", async () => {
    const fixture = await makeFixture(200, 100);
    mockDownloadOnce(fixture);

    const result = await cropImageTool.execute(
      { image_url: "https://example.com/a.png", width_px: 60, height_px: 40 },
      ctx(),
    );

    const artifact = result.artifacts[0];
    if (artifact.kind !== "bytes") throw new Error("expected bytes artifact");
    const outMeta = await sharp(artifact.body).metadata();
    expect(outMeta.width).toBe(60);
    expect(outMeta.height).toBe(40);
    // (200-60)/2 = 70, (100-40)/2 = 30 — verify the extracted region is the
    // centered slice, not the top-left slice, by checking pixel content
    // differs from a fixture with a distinct border color at the origin.
    const bordered = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    mockDownloadOnce(bordered);
    const centeredResult = await cropImageTool.execute(
      { image_url: "https://example.com/a.png", width_px: 60, height_px: 40 },
      ctx(),
    );
    const centeredArtifact = centeredResult.artifacts[0];
    if (centeredArtifact.kind !== "bytes") throw new Error("expected bytes artifact");
    const { data, info } = await sharp(centeredArtifact.body).raw().toBuffer({ resolveWithObject: true });
    // Top-left pixel of a centered 60x40 crop from a 200x100 source starts
    // at (70, 30) — well clear of the red 10x10 marker at the source's own
    // origin — so it must be the fixture's plain background color, not red.
    expect(info.channels).toBeGreaterThanOrEqual(3);
    expect(data[0]).toBe(10);
    expect(data[1]).toBe(20);
    expect(data[2]).toBe(30);
  });

  it("clamps a rect that would exceed source bounds instead of rejecting it", async () => {
    const fixture = await makeFixture(100, 100);
    mockDownloadOnce(fixture);

    const result = await cropImageTool.execute(
      { image_url: "https://example.com/a.png", width_px: 500, height_px: 500, x_px: 80, y_px: 80 },
      ctx(),
    );

    const artifact = result.artifacts[0];
    if (artifact.kind !== "bytes") throw new Error("expected bytes artifact");
    const outMeta = await sharp(artifact.body).metadata();
    // left/top clamp to 80, then width/height clamp to (100-80)=20 each.
    expect(outMeta.width).toBe(20);
    expect(outMeta.height).toBe(20);
  });

  it("throws CropExtractError (not a raw sharp error) when sharp.extract rejects a pathological rect", async () => {
    const fixture = await makeFixture(50, 50);
    mockDownloadOnce(fixture);

    // Clamping (per resolveCropRect) always produces a rect within
    // [0,width]x[0,height] with non-negative width/height, so a genuinely
    // unextractable rect cannot survive it in practice — verified by trying
    // every boundary/degenerate combination above without triggering a raw
    // sharp throw. To still exercise the classification path, monkeypatch
    // sharp's extract to throw as it would for an internal edge case.
    vi.doMock("sharp", async () => {
      const actual = await vi.importActual<typeof import("sharp")>("sharp");
      const wrapped = (...args: Parameters<typeof actual.default>) => {
        const instance = actual.default(...args);
        instance.extract = () => {
          throw new Error("extract_area: bad extract area");
        };
        return instance;
      };
      return { ...actual, default: wrapped };
    });
    vi.resetModules();
    // Re-import fresh, since vi.resetModules() gives this import a distinct
    // module instance (and thus a distinct CropExtractError class identity)
    // from the one imported at the top of this file.
    const { cropImageTool: freshTool, CropExtractError: FreshCropExtractError } = await import(
      "@/server/tools/adapters/crop-image"
    );

    await expect(
      freshTool.execute({ image_url: "https://example.com/a.png", width_px: 10, height_px: 10 }, ctx()),
    ).rejects.toBeInstanceOf(FreshCropExtractError);

    vi.doUnmock("sharp");
    vi.resetModules();
  });

  it("classifies a download failure as CropExtractError, not a silent swallow", async () => {
    safeDownloadToBuffer.mockRejectedValueOnce(new Error("network down"));

    await expect(
      cropImageTool.execute({ image_url: "https://example.com/a.png", width_px: 10, height_px: 10 }, ctx()),
    ).rejects.toBeInstanceOf(CropExtractError);
  });

  it("classifies a rejected (non-2xx) download as CropExtractError", async () => {
    safeDownloadToBuffer.mockRejectedValueOnce(new SafeDownloadError("Request returned HTTP 404."));

    await expect(
      cropImageTool.execute({ image_url: "https://example.com/a.png", width_px: 10, height_px: 10 }, ctx()),
    ).rejects.toBeInstanceOf(CropExtractError);
  });

  it("classifies an SSRF-rejected URL (UnsafeUrlError) as CropExtractError", async () => {
    safeDownloadToBuffer.mockRejectedValueOnce(new UnsafeUrlError("The referenced URL resolves to a disallowed address."));

    await expect(
      cropImageTool.execute({ image_url: "https://example.com/a.png", width_px: 10, height_px: 10 }, ctx()),
    ).rejects.toBeInstanceOf(CropExtractError);
  });

  it("passes MAX_CROP_SOURCE_BYTES as the byte cap to safeDownloadToBuffer", async () => {
    mockDownloadOnce(await makeFixture(10, 10));

    await cropImageTool.execute({ image_url: "https://example.com/a.png", width_px: 5, height_px: 5 }, ctx());

    expect(safeDownloadToBuffer).toHaveBeenCalledWith(
      "https://example.com/a.png",
      expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }),
    );
  });
});

describe("cropImageTool.estimateCredits", () => {
  it("returns TOOL_CREDIT_ESTIMATE.crop_image", () => {
    expect(cropImageTool.estimateCredits({} as never)).toBe(TOOL_CREDIT_ESTIMATE.crop_image);
    expect(TOOL_CREDIT_ESTIMATE.crop_image).toBe(0.1);
  });
});
