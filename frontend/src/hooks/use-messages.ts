"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import * as messagesService from "@/services/messages";

export const messageKeys = {
  list: (chatId: string) => ["chats", chatId, "messages"] as const,
};

export function useMessagesList(chatId: string | undefined) {
  const fetcher = useApiClient();
  return useInfiniteQuery({
    queryKey: messageKeys.list(chatId ?? ""),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      messagesService.listMessages(fetcher, chatId as string, { cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(chatId),
  });
}
