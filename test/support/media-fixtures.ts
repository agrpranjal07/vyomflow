/**
 * Real, tiny image fixtures for generate_image tests — generated with sharp
 * at test-setup time (never a hand-crafted base64 string), so magic-byte
 * sniffing in the adapter under test runs against genuinely decodable
 * bytes. Mirrors crop-image-adapter.test.ts's makeFixture() pattern.
 */
import sharp from "sharp";

async function makeSolidImage(width: number, height: number, format: "jpeg" | "png" | "webp"): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } },
  });
  if (format === "jpeg") return image.jpeg().toBuffer();
  if (format === "png") return image.png().toBuffer();
  return image.webp().toBuffer();
}

/** A small JPEG fixture, base64-encoded — matches Cloudflare's real always-JPEG output. */
export async function makeJpegBase64Fixture(width = 64, height = 64): Promise<string> {
  const buffer = await makeSolidImage(width, height, "jpeg");
  return buffer.toString("base64");
}

/** A reference-image fixture at a given size, as raw bytes (for a mocked fetch() response). */
export async function makePngFixtureBytes(width: number, height: number): Promise<Buffer> {
  return makeSolidImage(width, height, "png");
}

/** {success:false} Cloudflare error envelope fixture. */
export const CLOUDFLARE_FAILURE_BODY = {
  result: null,
  success: false,
  errors: [{ code: 5006, message: "unable to generate image" }],
  messages: [],
};

/** Malformed envelope — result present but missing the `image` field. */
export const CLOUDFLARE_MALFORMED_BODY = {
  result: {},
  success: true,
  errors: [],
  messages: [],
};
