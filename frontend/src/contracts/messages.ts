// GENERATED — do not edit. Source: 0f5444fa8bbe10c41e18f0fbcc89a4c3d6dd047a:src/contracts/messages.ts
import { z } from "zod";
import { ContentBlockSchema, CursorQuerySchema, PageSchema } from "@/contracts/common";
import { AttachmentDTOSchema } from "@/contracts/attachments";

// Sum of all `text` block lengths in one message. See AttachmentDTOSchema
// (S4, src/contracts/attachments.ts) for attachment-specific limits.
export const MAX_MESSAGE_TEXT_LENGTH = 8000;

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const MessageStatusSchema = z.enum(["streaming", "complete", "failed", "cancelled"]);

// S4 — the real Transloadit-backed attachment reference, replacing the S1
// placeholder ({ id }) additively: the send route resolves each id against
// an owned, READY, currently-unbound Attachment row (never trusts a client-
// supplied URL/status), per the S4 implementation plan.
export const AttachmentRefSchema = z.object({ id: z.string() });

// S2 — the only supported model route (00-master-spec.md §1: "OpenRouter
// Free (openrouter/free), no paid fallback"). Kept here as a pure-Zod
// constant (no Prisma/env import) so CreateMessageRequestSchema's model
// validation stays self-contained; src/lib/model-selection.ts re-exports it
// for the service layer rather than duplicating the literal.
export const OPENROUTER_FREE_MODEL = "openrouter/free";

export const CreateMessageRequestSchema = z
  .object({
    // S4: no longer .min(1) at the schema level — an attachment-only send
    // has an empty content array. The superRefine below enforces the real
    // invariant: non-empty text OR at least one attachment, never neither.
    content: z.array(ContentBlockSchema),
    attachments: z.array(AttachmentRefSchema).max(10).optional().default([]),
    // Model-selection validation (S2-streaming-turn.md) — exactly four
    // outcomes, no others:
    //   - field absent (undefined)              -> defaults to OPENROUTER_FREE_MODEL downstream
    //   - field === OPENROUTER_FREE_MODEL        -> accepted
    //   - field a non-empty string, anything else -> rejected below (paid/unsupported)
    //   - field wrong type / empty / unparseable -> rejected by z.string().trim().min(1) itself
    // "malformed" and "absent" must never collapse into the same outcome —
    // z.string() failing on a non-string, and min(1) failing on "" or
    // whitespace-only, are both distinct from `undefined` passing through.
    model: z.string().trim().min(1, "model must be a non-empty string.").optional(),
  })
  .superRefine((data, ctx) => {
    const textLength = data.content
      .filter((block) => block.type === "text")
      .reduce((sum, block) => sum + block.text.length, 0);

    // S4: an attachment-only send (no text) is valid — only reject empty
    // text when there are also no attachments to carry the message.
    if (textLength === 0 && data.attachments.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Message must contain non-empty text or at least one attachment.",
        path: ["content"],
      });
    } else if (textLength > MAX_MESSAGE_TEXT_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `Message exceeds the ${MAX_MESSAGE_TEXT_LENGTH}-character limit.`,
        path: ["content"],
      });
    }

    if (data.model !== undefined && data.model !== OPENROUTER_FREE_MODEL) {
      ctx.addIssue({
        code: "custom",
        message: `Unsupported model "${data.model}". Only "${OPENROUTER_FREE_MODEL}" is supported.`,
        path: ["model"],
      });
    }
  });
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

export const MessageDTOSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: MessageRoleSchema,
  status: MessageStatusSchema,
  content: z.array(ContentBlockSchema),
  // S4 — attachments are a relation, not a content block (00-master-spec.md
  // §6's Attachment entity is its own table); rendered order matches
  // orderIndex, per the S4 implementation plan.
  attachments: z.array(AttachmentDTOSchema),
  createdAt: z.string(),
});
export type MessageDTO = z.infer<typeof MessageDTOSchema>;

export const ListMessagesQuerySchema = CursorQuerySchema;

export const ListMessagesResponseSchema = PageSchema(MessageDTOSchema);
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;
