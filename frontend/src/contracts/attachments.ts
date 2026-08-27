// GENERATED — do not edit. Source: 1173916808585c5b39a4dfd2d96256d6ec489be5:src/contracts/attachments.ts
/**
 * S4 — Attachments (direct upload via Transloadit/Uppy/tus). Pure Zod only,
 * same rule as every other file under src/contracts/** (00-master-spec.md
 * §2): no Prisma types, no Next.js types. Copied verbatim into the frontend
 * by `contracts:sync`.
 *
 * Distinct from tools.ts's ToolInvocation resultUrls/sourceUrls, which are
 * *generated* assets (S3/S7) — this file covers only user-supplied direct
 * uploads. See the S4 implementation plan for the design this mirrors:
 * unbound (messageId: null) READY rows are the user's asset library, no
 * separate Library/Asset entity.
 */
import { z } from "zod";
import { CursorQuerySchema, PageSchema } from "@/contracts/common";

export const AttachmentStatusSchema = z.enum(["PENDING", "READY", "FAILED", "CANCELLED"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;

// Application-level limits (assignment §5 "Limits": attachment count, file
// metadata, MIME types, supported media types, Transloadit Community-plan
// limits). Community plan itself caps 5GB/month, 0.5GB/file — these stay
// at or under that ceiling, never above it (R7: never require paid
// overage).
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 0.5GB per-file cap (Community plan)
export const MAX_MONTHLY_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5GB/month (Community plan)

// S4: caps on how many attachments get sent to the model as real
// `image_url` vision content (vs. just their URL in the text line) — keeps
// the OpenRouter request bounded regardless of how many images a chat
// accumulates. Images beyond either cap still get their URL in the text
// line, so tool-call chaining is unaffected.
export const MAX_IMAGE_PARTS_PER_MESSAGE = 4;
export const MAX_IMAGE_PARTS_PER_REQUEST = 8;
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
] as const;
export const AllowedAttachmentMimeTypeSchema = z.enum(ALLOWED_ATTACHMENT_MIME_TYPES);

// One request = one signed-params mint per file (never a single shared
// signature for a batch — a per-file Assembly is what keeps cancel/retry/
// per-file failure independent, per the S4 implementation plan).
export const RequestUploadParamsRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: AllowedAttachmentMimeTypeSchema,
  byteSize: z.number().int().positive().max(MAX_ATTACHMENT_BYTES, "File exceeds the 0.5GB per-file limit."),
});
export type RequestUploadParamsRequest = z.infer<typeof RequestUploadParamsRequestSchema>;

// Batch wrapper — one call mints params for every file in one attach
// action, preserving the client's own drop/select order via orderIndex on
// the created rows (assignment: "preserve ... attachment order"). `chatId`
// scopes ownership/orderIndex-continuation to a single chat's pending
// attachment set (route is not chat-nested, so this must travel in the body).
// Optional: the empty-state composer attaches a file before any chat exists
// — those rows stay chatless (see AttachmentDTO.chatId) until the first
// send binds them to the chat created at that point, so no empty "New chat"
// row is ever persisted just from attaching.
export const RequestUploadParamsBatchRequestSchema = z.object({
  chatId: z.string().min(1).optional(),
  files: z.array(RequestUploadParamsRequestSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE),
});
export type RequestUploadParamsBatchRequest = z.infer<typeof RequestUploadParamsBatchRequestSchema>;

// Signed Assembly params for exactly one file's direct tus upload — the
// secret itself never leaves the backend (assignment: "Create signed
// Assembly parameters on the backend; never expose the Transloadit
// secret.").
export const SignedUploadParamsSchema = z.object({
  attachmentId: z.string(),
  params: z.string(),
  signature: z.string(),
});
export type SignedUploadParams = z.infer<typeof SignedUploadParamsSchema>;

export const RequestUploadParamsResponseSchema = z.object({
  uploads: z.array(SignedUploadParamsSchema),
});
export type RequestUploadParamsResponse = z.infer<typeof RequestUploadParamsResponseSchema>;

// Client signals completion; the server never trusts a client-supplied
// result URL — it re-fetches the Assembly status itself before persisting
// READY (S4 implementation plan §4 "Completion is server-verified").
export const CompleteAttachmentRequestSchema = z.object({
  assemblyId: z.string().min(1),
});
export type CompleteAttachmentRequest = z.infer<typeof CompleteAttachmentRequestSchema>;

// "uploaded" — a real Attachment row (direct Transloadit upload). "generated"
// — a synthetic, non-persisted item projected from a COMPLETED ToolInvocation's
// resultUrls (crop_image/generate_image/merge_videos output) at read time for
// the media library only; it has no Attachment row, no delete/bind lifecycle
// of its own, and `id` is a composite (`{toolInvocationId}:{urlIndex}`), not a
// real Attachment id.
export const AttachmentSourceSchema = z.enum(["uploaded", "generated"]);

export const AttachmentDTOSchema = z.object({
  id: z.string(),
  // Null until the first send binds this attachment to a (newly created or
  // existing) chat — see RequestUploadParamsBatchRequestSchema's comment.
  chatId: z.string().nullable(),
  messageId: z.string().nullable(),
  orderIndex: z.number().int().nonnegative(),
  status: AttachmentStatusSchema,
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  fileName: z.string().nullable(),
  resultUrl: z.url().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: AttachmentSourceSchema,
});
export type AttachmentDTO = z.infer<typeof AttachmentDTOSchema>;

// GET /api/v1/attachments — unbound=true lists the caller's media library
// (all owned READY uploads, bound or not, merged with every COMPLETED
// generated tool result — optionally narrowed by `source`), newest-first;
// otherwise scoped to a single chat's bound rows for that chat's send-time
// picker.
export const ListAttachmentsQuerySchema = CursorQuerySchema.extend({
  chatId: z.string().min(1).optional(),
  // z.coerce.boolean() would treat the literal string "false" as truthy —
  // enum + transform is the correct coercion for a query-string flag.
  unbound: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  // Library-only filter (ignored outside unbound=true mode).
  source: z.enum(["all", "uploaded", "generated"]).optional(),
});
export type ListAttachmentsQuery = z.infer<typeof ListAttachmentsQuerySchema>;

export const ListAttachmentsResponseSchema = PageSchema(AttachmentDTOSchema);
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;

export const AttachmentIdParamSchema = z.object({ attachmentId: z.string().min(1) });
