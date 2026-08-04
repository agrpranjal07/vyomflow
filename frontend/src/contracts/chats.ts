// GENERATED — do not edit. Source: 0f5444fa8bbe10c41e18f0fbcc89a4c3d6dd047a:src/contracts/chats.ts
import { z } from "zod";
import { CursorQuerySchema, PageSchema } from "@/contracts/common";

export const CreateChatRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;

export const UpdateChatRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type UpdateChatRequest = z.infer<typeof UpdateChatRequestSchema>;

export const ChatDTOSchema = z.object({
  id: z.string(),
  title: z.string(),
  pinnedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // S2 — the id of this chat's non-terminal AgentRun, if any (reload-
  // recovery primitive: the frontend uses this to know which run to
  // resume streaming from on mount). Optional/omitted in list responses,
  // where computing it per-row would be an extra query per chat; always
  // present (real value or null) on the single-chat GET.
  activeRunId: z.string().nullable().optional(),
});
export type ChatDTO = z.infer<typeof ChatDTOSchema>;

export const ListChatsQuerySchema = CursorQuerySchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  pinned: z.coerce.boolean().optional(),
});
export type ListChatsQuery = z.infer<typeof ListChatsQuerySchema>;

export const ListChatsResponseSchema = PageSchema(ChatDTOSchema);
export type ListChatsResponse = z.infer<typeof ListChatsResponseSchema>;

export const ChatIdParamSchema = z.object({ chatId: z.string().min(1) });
