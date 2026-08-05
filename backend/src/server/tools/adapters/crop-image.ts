/**
 * crop_image adapter — media-tool arm (sharp, in-process). Input shape
 * follows the live-verified schema, not `crop.{x,y,width,height}` wording —
 * see ../../../contracts/tools.ts's file header for the recorded
 * contradiction. Implements MediaToolFields.execute directly, in-process.
 */
import { CROP_IMAGE_TOOL_NAME, CropImageInputSchema, type CropImageInput } from "@/contracts/tools";
import { TOOL_CREDIT_ESTIMATE } from "@/lib/config";
import { safeDownloadToBuffer, SafeDownloadError, UnsafeUrlError } from "@/lib/safe-download";
import type { ToolDefinition } from "@/server/tools/registry";

/** Local guard: only this adapter downloads a source image, so the cap lives here rather than in config.ts. */
const MAX_CROP_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * Distinguishes crop-specific failures (fetch/size-guard/decode/extract) from
 * other errors so Phase 3's classifyMediaToolError taxonomy has a type to
 * switch on instead of matching sharp's raw message strings.
 */
export class CropExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CropExtractError";
  }
}

function resolveCropRect(input: CropImageInput, width: number, height: number) {
  let left: number;
  let top: number;
  let cropWidth: number;
  let cropHeight: number;

  if (input.width_percent !== undefined) {
    left = Math.round(((input.x_percent ?? 0) / 100) * width);
    top = Math.round(((input.y_percent ?? 0) / 100) * height);
    cropWidth = Math.round((input.width_percent / 100) * width);
    cropHeight = Math.round((input.height_percent! / 100) * height);
  } else {
    cropWidth = Math.round(input.width_px!);
    cropHeight = Math.round(input.height_px!);
    // Omitted x_px/y_px centers the crop (contracts/tools.ts's field
    // description; VYOMFLOW_IMPLEMENTATION_SPEC.md §7 step 3) — not
    // top-left. Explicit x_px/y_px are used verbatim when given.
    left = Math.round(input.x_px ?? (width - cropWidth) / 2);
    top = Math.round(input.y_px ?? (height - cropHeight) / 2);
  }

  // Clamp the rect so it never falls outside [0, width] x [0, height] — a
  // client-supplied rect can still be pathological after clamping (e.g.
  // left already at width), which sharp's own .extract() rejects; that
  // path is handled by the try/catch around extract() below.
  left = Math.min(Math.max(left, 0), width);
  top = Math.min(Math.max(top, 0), height);
  cropWidth = Math.min(Math.max(cropWidth, 0), width - left);
  cropHeight = Math.min(Math.max(cropHeight, 0), height - top);

  return { left, top, width: cropWidth, height: cropHeight };
}

export const cropImageTool: ToolDefinition<CropImageInput> = {
  name: CROP_IMAGE_TOOL_NAME,
  description:
    "Crop an image. Provide image_url plus either a complete percent rectangle " +
    "(x_percent, y_percent, width_percent, height_percent) or a complete pixel " +
    "rectangle (width_px, height_px, with optional x_px/y_px to position it).",
  inputSchema: CropImageInputSchema,
  engine: "sharp",

  estimateCredits: () => TOOL_CREDIT_ESTIMATE.crop_image,

  async execute(input, ctx) {
    let buffer: Buffer;
    try {
      buffer = await safeDownloadToBuffer(input.image_url, { maxBytes: MAX_CROP_SOURCE_BYTES, signal: ctx.signal });
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof SafeDownloadError) {
        throw new CropExtractError(`crop_image: ${err.message}`);
      }
      throw new CropExtractError(`crop_image: failed to fetch image_url: ${(err as Error).message}`);
    }

    // Lazy import: registry.ts (and therefore this file) is transitively
    // reachable from the Next.js server graph, so a top-of-file static
    // import would load sharp's native binary into the Next process even
    // when no crop ever runs.
    const sharp = (await import("sharp")).default;

    let metadata: { width?: number; height?: number };
    try {
      metadata = await sharp(buffer).metadata();
    } catch (err) {
      throw new CropExtractError(`crop_image: could not decode source image: ${(err as Error).message}`);
    }
    if (!metadata.width || !metadata.height) {
      throw new CropExtractError("crop_image: decoded image reported no width/height");
    }

    const rect = resolveCropRect(input, metadata.width, metadata.height);

    try {
      const { data, info } = await sharp(buffer)
        .extract(rect)
        .toBuffer({ resolveWithObject: true });
      return {
        artifacts: [
          {
            kind: "bytes",
            body: data,
            contentType: `image/${info.format}`,
            filename: `cropped.${info.format}`,
          },
        ],
      };
    } catch (err) {
      throw new CropExtractError(`crop_image: sharp extract failed: ${(err as Error).message}`);
    }
  },
};
