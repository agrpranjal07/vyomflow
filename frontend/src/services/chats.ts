import type { Fetcher } from "@/lib/api-client";
import {
  ChatDTOSchema,
  ListChatsResponseSchema,
  type ChatDTO,
  type CreateChatRequest,
  type ListChatsQuery,
  type ListChatsResponse,
  type UpdateChatRequest,
} from "@/contracts/chats";

export async function listChats(fetcher: Fetcher, query: ListChatsQuery): Promise<ListChatsResponse> {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.q) params.set("q", query.q);
  if (query.pinned !== undefined) params.set("pinned", String(query.pinned));

  const raw = await fetcher(`/api/v1/chats?${params.toString()}`);
  return ListChatsResponseSchema.parse(raw);
}

export async function createChat(fetcher: Fetcher, body: CreateChatRequest): Promise<ChatDTO> {
  const raw = await fetcher("/api/v1/chats", { method: "POST", body: JSON.stringify(body) });
  return ChatDTOSchema.parse(raw);
}

export async function getChat(fetcher: Fetcher, chatId: string): Promise<ChatDTO> {
  const raw = await fetcher(`/api/v1/chats/${chatId}`);
  return ChatDTOSchema.parse(raw);
}

export async function deleteChat(fetcher: Fetcher, chatId: string): Promise<void> {
  await fetcher(`/api/v1/chats/${chatId}`, { method: "DELETE" });
}

export async function setChatPinned(fetcher: Fetcher, chatId: string, pinned: boolean): Promise<ChatDTO> {
  const raw = await fetcher(`/api/v1/chats/${chatId}/pin`, { method: pinned ? "POST" : "DELETE" });
  return ChatDTOSchema.parse(raw);
}

export async function renameChat(fetcher: Fetcher, chatId: string, title: string): Promise<ChatDTO> {
  const body: UpdateChatRequest = { title };
  const raw = await fetcher(`/api/v1/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(body) });
  return ChatDTOSchema.parse(raw);
}
