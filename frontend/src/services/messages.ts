import type { Fetcher } from "@/lib/api-client";
import { ListMessagesResponseSchema, type ListMessagesResponse } from "@/contracts/messages";
import type { CursorQuery } from "@/contracts/common";

export async function listMessages(fetcher: Fetcher, chatId: string, query: CursorQuery): Promise<ListMessagesResponse> {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));

  const raw = await fetcher(`/api/v1/chats/${chatId}/messages?${params.toString()}`);
  return ListMessagesResponseSchema.parse(raw);
}
