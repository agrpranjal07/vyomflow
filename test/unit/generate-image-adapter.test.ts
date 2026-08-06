import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { GenerateImageInputSchema } from "@/contracts/tools";
import { TOOL_CREDIT_ESTIMATE } from "@/lib/config";

// generate-image.ts downloads reference images via lib/safe-download.ts's
// safeDownloadToBuffer (SSRF-safe: DNS-resolves and validates the
// destination before any bytes move), not a bare fetch — mocked here so
// these tests can serve reference-image bytes directly without needing a
// real DNS-resolvable host. safe-download.ts's own SSRF logic is covered by
// unit/safe-download.test.ts.
const { safeDownloadToBuffer } = vi.hoisted(() => ({ safeDownloadToBuffer: vi.fn() }));
vi.mock("@/lib/safe-download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-download")>();
  return { ...actual, safeDownloadToBuffer };
});

import { generateImageTool, CloudflareGenerationError } from "@/server/tools/adapters/generate-image";
import {
  cloudflareServer,
  cloudflareSuccessHandler,
  cloudflareFailureHandler,
  cloudflareHttpErrorHandler,
  cloudflareDelayedHandler,
  cloudflareCapturingHandler,
  CLOUDFLARE_ACCOUNT_ID,
} from "../support/msw-cloudflare";
import { makeJpegBase64Fixture, makePngFixtureBytes, CLOUDFLARE_MALFORMED_BODY } from "../support/media-fixtures";

beforeAll(() => cloudflareServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => cloudflareServer.resetHandlers());
afterAll(() => cloudflareServer.close());

beforeEach(() => {
  process.env.CLOUDFLARE_ACCOUNT_ID = CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = "test_token";
});

afterEach(() => {
  safeDownloadToBuffer.mockReset();
});

function ctx(signal?: AbortSignal) {
  return {
    toolInvocationId: "ti_1",
    agentRunId: "ar_1",
    ownerId: "user_1",
    workDir: "/tmp/does-not-matter",
    signal: signal ?? new AbortController().signal,
  };
}

/** Maps each reference-image URL to the bytes safeDownloadToBuffer should resolve for it. */
function mockReferenceImages(byUrl: Record<string, Buffer>) {
  safeDownloadToBuffer.mockImplementation(async (url: string) => {
    const bytes = byUrl[url];
    if (!bytes) throw new Error(`unexpected reference-image URL in test: ${url}`);
    return bytes;
  });
}

describe("generateImageTool.execute", () => {
  it("generates from a text prompt only (no images)", async () => {
    const base64 = await makeJpegBase64Fixture(64, 64);
    cloudflareServer.use(cloudflareSuccessHandler(base64));

    const result = await generateImageTool.execute({ prompt: "a red fox in the snow" }, ctx());

    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0];
    if (artifact.kind !== "bytes") throw new Error("expected bytes artifact");
    expect(artifact.contentType).toBe("image/jpeg");
    const meta = await sharp(artifact.body).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });

  it("sends input_image_0..N fields for reference-image editing", async () => {
    const base64 = await makeJpegBase64Fixture();
    const refBytes = await makePngFixtureBytes(100, 100);
    let capturedForm: FormData | undefined;
    mockReferenceImages({
      "https://example.com/ref-a.png": refBytes,
      "https://example.com/ref-b.png": refBytes,
    });
    cloudflareServer.use(
      cloudflareCapturingHandler(base64, (form) => {
        capturedForm = form;
      }),
    );

    await generateImageTool.execute(
      { prompt: "edit these", images: ["https://example.com/ref-a.png", "https://example.com/ref-b.png"] },
      ctx(),
    );

    expect(capturedForm).toBeDefined();
    expect(capturedForm!.has("input_image_0")).toBe(true);
    expect(capturedForm!.has("input_image_1")).toBe(true);
    expect(capturedForm!.has("input_image_2")).toBe(false);
  });

  it("downscales a reference image >=512px before attaching it", async () => {
    const base64 = await makeJpegBase64Fixture();
    const bigRef = await makePngFixtureBytes(1024, 800);
    let capturedForm: FormData | undefined;
    mockReferenceImages({ "https://example.com/big-ref.png": bigRef });
    cloudflareServer.use(
      cloudflareCapturingHandler(base64, (form) => {
        capturedForm = form;
      }),
    );

    await generateImageTool.execute({ prompt: "edit this", images: ["https://example.com/big-ref.png"] }, ctx());

    const attached = capturedForm!.get("input_image_0") as Blob;
    expect(attached).toBeTruthy();
    const attachedBuffer = Buffer.from(await attached.arrayBuffer());
    const meta = await sharp(attachedBuffer).metadata();
    expect(meta.width!).toBeLessThan(512);
    expect(meta.height!).toBeLessThan(512);
  });

  it("throws a typed error when result.image is missing (malformed response)", async () => {
    cloudflareServer.use(http.post(/.*flux-2-klein-4b$/, () => HttpResponse.json(CLOUDFLARE_MALFORMED_BODY)));

    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toBeInstanceOf(CloudflareGenerationError);
  });

  it("throws a typed error on success:false", async () => {
    cloudflareServer.use(cloudflareFailureHandler([{ code: 5006, message: "unable to generate image" }]));

    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toMatchObject({
      name: "CloudflareGenerationError",
    });
  });

  it("throws a typed error on HTTP 4xx", async () => {
    cloudflareServer.use(cloudflareHttpErrorHandler(400));
    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toBeInstanceOf(CloudflareGenerationError);
  });

  it("throws a typed error on HTTP 5xx", async () => {
    cloudflareServer.use(cloudflareHttpErrorHandler(503));
    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toBeInstanceOf(CloudflareGenerationError);
  });

  it("throws a typed error on caller-signal abort instead of hanging", async () => {
    const base64 = await makeJpegBase64Fixture();
    cloudflareServer.use(cloudflareDelayedHandler(base64, 2000));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    await expect(generateImageTool.execute({ prompt: "x" }, ctx(controller.signal))).rejects.toBeInstanceOf(
      CloudflareGenerationError,
    );
  }, 10_000);

  it("throws a typed error when decoded image bytes are empty", async () => {
    cloudflareServer.use(cloudflareSuccessHandler(""));
    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toBeInstanceOf(CloudflareGenerationError);
  });

  it("throws a typed error when decoded bytes fail magic-byte sniffing", async () => {
    const garbage = Buffer.from("not an image at all").toString("base64");
    cloudflareServer.use(cloudflareSuccessHandler(garbage));
    await expect(generateImageTool.execute({ prompt: "x" }, ctx())).rejects.toBeInstanceOf(CloudflareGenerationError);
  });

  it("n=2 triggers exactly 2 Cloudflare calls and returns 2 artifacts", async () => {
    const base64 = await makeJpegBase64Fixture();
    let callCount = 0;
    cloudflareServer.use(
      http.post(/.*flux-2-klein-4b$/, () => {
        callCount += 1;
        return HttpResponse.json({ result: { image: base64 }, success: true, errors: [], messages: [] });
      }),
    );

    const result = await generateImageTool.execute({ prompt: "x", n: 2 }, ctx());
    expect(callCount).toBe(2);
    expect(result.artifacts).toHaveLength(2);
  });
});

describe("generateImageTool.estimateCredits", () => {
  it("scales with n", () => {
    expect(generateImageTool.estimateCredits(GenerateImageInputSchema.parse({ prompt: "x" }))).toBe(
      TOOL_CREDIT_ESTIMATE.generate_image,
    );
    expect(generateImageTool.estimateCredits(GenerateImageInputSchema.parse({ prompt: "x", n: 3 }))).toBe(
      TOOL_CREDIT_ESTIMATE.generate_image * 3,
    );
  });
});

describe("GenerateImageInputSchema", () => {
  it("rejects removed fields quality/background/output_compression", () => {
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", quality: "High" }).success).toBe(false);
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", background: "Auto" }).success).toBe(false);
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", output_compression: 50 }).success).toBe(false);
  });

  it("accepts a valid minimal input", () => {
    expect(GenerateImageInputSchema.safeParse({ prompt: "x" }).success).toBe(true);
  });

  it("accepts seed and guidance", () => {
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", seed: 42, guidance: 3.5 }).success).toBe(true);
  });

  it("rejects a custom size outside 256-1920", () => {
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", size: { width: 100, height: 100 } }).success).toBe(false);
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", size: { width: 2000, height: 2000 } }).success).toBe(false);
  });

  it("accepts a custom size within 256-1920", () => {
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", size: { width: 512, height: 512 } }).success).toBe(true);
  });

  it("rejects more than 4 reference images", () => {
    const images = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.png`);
    expect(GenerateImageInputSchema.safeParse({ prompt: "x", images }).success).toBe(false);
  });
});
