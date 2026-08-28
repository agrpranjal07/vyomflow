// GENERATED — do not edit. Source: c9a2eb298ce02df0d3dd251bf7973b1da3131683:src/contracts/tools.ts
/**
 * S3 — Typed Tool Registry + 3 Real Media-Tool Adapters. Pure Zod only, same
 * rules as every other file under src/contracts/** (00-master-spec.md §2):
 * no Prisma types, no Next.js types. Copied verbatim into the frontend by
 * `contracts:sync`.
 *
 * Per-tool input schemas here are the single authoritative source the
 * registry derives everything else from (assignment §2: "Tool discovery,
 * input validation, execution, credit estimation, and result rendering
 * must derive from one authoritative registry") — the OpenAI-format JSON
 * Schema the model sees, the sanitized snapshot persisted to
 * ToolInvocation.input, and the payload each in-process adapter executes
 * against are all built from these same schemas, never duplicated by hand.
 *
 * Field shapes verified live against the reference implementation's model-schema endpoint
 * immediately before this file was written (2026-08-20) —
 * ../../.claude/state/recon-findings.md, "Session-5" section. Notably:
 * crop_image has NO `crop.{x,y,width,height}` object field despite the
 * assignment's own wording (contradiction resolved in the live schema's
 * favor, per the assignment's own "resolve from the schema, not a stale
 * duplicate" instruction); gpt-image-2-edit's image field is
 * `uploadedImages`, not "Input Images"; `size`'s custom form is an object,
 * never the literal string "Custom".
 */
import { z } from "zod";

// Mirrors prisma/schema.prisma's ToolInvocationStatus enum.
export const ToolInvocationStatusSchema = z.enum([
  "DISPATCHING",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatusSchema>;

// ---------------------------------------------------------------------------
// crop_image
// ---------------------------------------------------------------------------

export const CROP_IMAGE_TOOL_NAME = "crop_image";

// Flat percent + flat pixel field sets only — live schema confirmed no
// nested `crop` object (see file header). At least one complete rectangle
// (all-percent or all-pixel) must be present; a partial set of either is
// rejected ("validate complete rectangles" — assignment §6).
export const CropImageInputSchema = z
  .object({
    image_url: z
      .url("image_url must be a valid HTTPS URL.")
      .refine((url) => url.startsWith("https://"), "image_url must be a valid HTTPS URL."),
    x_percent: z.number().min(0).max(100).optional(),
    y_percent: z.number().min(0).max(100).optional(),
    width_percent: z.number().min(0).max(100).optional(),
    height_percent: z.number().min(0).max(100).optional(),
    width_px: z.number().int().positive().optional(),
    height_px: z.number().int().positive().optional(),
    x_px: z.number().int().nonnegative().optional(),
    y_px: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    const percentFields = [data.x_percent, data.y_percent, data.width_percent, data.height_percent];
    const anyPercent = percentFields.some((v) => v !== undefined);
    const allPercent = percentFields.every((v) => v !== undefined);
    if (anyPercent && !allPercent) {
      ctx.addIssue({
        code: "custom",
        message: "Percent crop requires x_percent, y_percent, width_percent, and height_percent together.",
        path: ["x_percent"],
      });
    }

    if (allPercent) {
      if (!(data.width_percent! > 0) || !(data.height_percent! > 0)) {
        ctx.addIssue({
          code: "custom",
          message: "width_percent and height_percent must be greater than 0.",
          path: ["width_percent"],
        });
      }
      if (data.x_percent! + data.width_percent! > 100) {
        ctx.addIssue({
          code: "custom",
          message: "x_percent + width_percent must not exceed 100.",
          path: ["width_percent"],
        });
      }
      if (data.y_percent! + data.height_percent! > 100) {
        ctx.addIssue({
          code: "custom",
          message: "y_percent + height_percent must not exceed 100.",
          path: ["height_percent"],
        });
      }
    }

    // Pixel crop requires at minimum width_px + height_px (x_px/y_px are
    // optional — omitting them centers the crop, per the live schema's own
    // field descriptions).
    const anyPixel = [data.width_px, data.height_px, data.x_px, data.y_px].some((v) => v !== undefined);
    const pixelSizeComplete = data.width_px !== undefined && data.height_px !== undefined;
    if (anyPixel && !pixelSizeComplete) {
      ctx.addIssue({
        code: "custom",
        message: "Pixel crop requires at least width_px and height_px together.",
        path: ["width_px"],
      });
    }

    if (!anyPercent && !anyPixel) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either a complete percent crop or a complete pixel crop.",
        path: ["image_url"],
      });
    }

    if (allPercent && pixelSizeComplete) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either a percent crop or a pixel crop, not both.",
        path: ["image_url"],
      });
    }
  });
export type CropImageInput = z.infer<typeof CropImageInputSchema>;

// ---------------------------------------------------------------------------
// generate_image — Cloudflare Workers AI @cf/black-forest-labs/flux-2-klein-4b
// (formerly gpt_image_2 / the reference implementation's dispatch adapter).
// This is a REDESIGN, not a rename — see
// .claude/plans/make-a-complete-implementation-jaunty-floyd.md, "The one
// thing the specs got materially wrong". Bounds are Cloudflare's real
// documented 256-1920px-per-side range (recon-findings.md §7,
// live-verified 2026-08-26), not the old 1024-3840 reference-implementation range.
// ---------------------------------------------------------------------------

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

const GENERATE_IMAGE_SIZE_PRESETS = [
  "512x512",
  "768x768",
  "1024x1024",
  "1344x768",
  "768x1344",
  "1920x1080",
  "1080x1920",
] as const;

// No Cloudflare-documented step/multiple-of-N or total-pixel requirement was
// found (model page's own schema section lists only the base64 output field —
// verified live via WebFetch 2026-08-26, not invented). Only range and
// long:short aspect-ratio are enforced; a step constraint is deliberately
// NOT asserted for lack of evidence, per the plan's explicit instruction not
// to invent one.
const GenerateImageCustomSizeSchema = z
  .object({ width: z.number().int(), height: z.number().int() })
  .superRefine((size, ctx) => {
    const inRange = (n: number) => n >= 256 && n <= 1920;
    if (!inRange(size.width) || !inRange(size.height)) {
      ctx.addIssue({
        code: "custom",
        message: "width and height must each be between 256 and 1920.",
        path: ["width"],
      });
      return;
    }
    const longToShort = Math.max(size.width, size.height) / Math.min(size.width, size.height);
    if (longToShort > 3) {
      ctx.addIssue({ code: "custom", message: "long-to-short ratio must not exceed 3:1.", path: ["width"] });
    }
  });

export const GenerateImageSizeSchema = z.union([z.enum(GENERATE_IMAGE_SIZE_PRESETS), GenerateImageCustomSizeSchema]);

export const GenerateImageInputSchema = z
  .object({
    prompt: z.string().trim().min(1, "prompt must not be empty.").max(4000, "prompt must be at most 4000 characters."),
    // Reference images for editing — Cloudflare accepts at most 4
    // (input_image_0..3), each required to be <512px on both sides (the
    // adapter downscales with sharp before attaching); narrowed from
    // gpt_image_2's 10-image cap, which Cloudflare cannot support.
    images: z
      .array(z.url())
      .min(1, "images must not be empty when provided.")
      .max(4, "generate_image accepts at most 4 reference images.")
      .optional(),
    size: GenerateImageSizeSchema.optional(),
    // Implemented as N sequential Cloudflare calls (one image per call) —
    // see the adapter's estimateCredits, which scales with n.
    n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    // Post-processing conversion via sharp — Cloudflare always returns
    // JPEG regardless of what's requested here (recon-findings.md §7).
    output_format: z.enum(["PNG", "JPEG", "WebP"]).optional(),
    // Real klein-4b params with no prior contract expression.
    seed: z.number().int().optional(),
    // No documented range for `guidance` was found (unverified) — a
    // conservative open-ended positive-number bound only, not a fabricated
    // min/max.
    guidance: z.number().positive().optional(),
  })
  // .strict() rejects any unrecognized key (unrecognized_keys issue) — in
  // particular quality/background/output_compression, which Cloudflare has
  // no equivalent for and must fail loud rather than be silently dropped.
  .strict();
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;

// ---------------------------------------------------------------------------
// merge_videos
// ---------------------------------------------------------------------------

export const MERGE_VIDEOS_TOOL_NAME = "merge_videos";

// Clip-count cap shrunk from the old reference-implementation-era 2-100 to 2-12 (VyomFlow
// migration plan §B3 "small bounded cap") — 12 clips through an ffmpeg
// xfade chain is a reasonable bound on a small-2x Trigger.dev machine;
// this exact number is a judgment call, open to revision against real
// throughput. Total-duration and total-size guards can't be expressed here
// (they need real ffprobe-measured data) — see merge-videos.ts's execute().
const MERGE_VIDEOS_MAX_CLIPS = 12;

export const MergeVideosInputSchema = z
  .object({
    video_urls: z
      .array(z.url())
      .min(2, `Provide between 2 and ${MERGE_VIDEOS_MAX_CLIPS} video URLs to merge.`)
      .max(MERGE_VIDEOS_MAX_CLIPS, `Provide between 2 and ${MERGE_VIDEOS_MAX_CLIPS} video URLs to merge.`),
    transition: z.enum(["none", "fade", "dissolve"]).optional(),
    // Default when omitted (transition !== "none"): 1.0 seconds — applied in
    // merge-videos.ts's execute(), not here. The upper bound (must be less
    // than the shortest adjacent-pair usable duration) requires each clip's
    // real ffprobe-measured duration, which needs network + a subprocess;
    // superRefine must stay synchronous/side-effect-free, so that half of
    // the validation lives in execute() — see the comment there pointing
    // back to this one.
    transitionDurationSeconds: z.number().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.transition === "none" && data.transitionDurationSeconds !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'transitionDurationSeconds must not be supplied when transition is "none".',
        path: ["transitionDurationSeconds"],
      });
    }
    if (
      data.transition !== "none" &&
      data.transitionDurationSeconds !== undefined &&
      !(data.transitionDurationSeconds > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "transitionDurationSeconds must be greater than 0.",
        path: ["transitionDurationSeconds"],
      });
    }
  });
export type MergeVideosInput = z.infer<typeof MergeVideosInputSchema>;

// ---------------------------------------------------------------------------
// Registry-facing spec + persisted/DTO shapes
// ---------------------------------------------------------------------------

export const ToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  nodeType: z.string(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

// Sanitized, persisted/rendered view of a ToolInvocation row
// (00-master-spec.md §6) — `input` here is always the sanitized snapshot
// already written to the DB, never a raw pass-through of model output, and
// never a provider secret.
export const ToolInvocationDTOSchema = z.object({
  id: z.string(),
  agentRunId: z.string(),
  turnIndex: z.number().int().nonnegative(),
  callIndex: z.number().int().nonnegative(),
  toolCallId: z.string(),
  name: z.string(),
  nodeType: z.string(),
  input: z.record(z.string(), z.unknown()),
  status: ToolInvocationStatusSchema,
  creditEstimate: z.number().nonnegative().nullable(),
  creditUsed: z.number().nonnegative().nullable(),
  resultUrls: z.array(z.url()).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ToolInvocationDTO = z.infer<typeof ToolInvocationDTOSchema>;

// ---------------------------------------------------------------------------
// ask_user (S6 — waitpoint clarification path,
// .claude/specs/S6-reliability-implementation-plan.md §6.2a/§7.1). A local
// tool (kind: "local") for registration/discovery only — its *dispatch* is
// not the synchronous local-tool path; turn.ts intercepts it by name to
// suspend the run on a Waitpoint instead of returning immediately.
// ---------------------------------------------------------------------------

export const ASK_USER_TOOL_NAME = "ask_user";

export const AskUserInputSchema = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
});
export type AskUserInput = z.infer<typeof AskUserInputSchema>;
