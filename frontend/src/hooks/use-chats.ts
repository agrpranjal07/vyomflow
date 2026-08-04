"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import * as chatsService from "@/services/chats";
import type { CreateChatRequest } from "@/contracts/chats";

export const chatKeys = {
  all: ["chats"] as const,
  list: (params: { q?: string; pinned?: boolean }) => ["chats", "list", params] as const,
  detail: (chatId: string) => ["chats", "detail", chatId] as const,
};

export function useChatsList(params: { q?: string; pinned?: boolean } = {}, options: { enabled?: boolean } = {}) {
  const fetcher = useApiClient();
  return useInfiniteQuery({
    queryKey: chatKeys.list(params),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      chatsService.listChats(fetcher, { ...params, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

export function useChat(chatId: string | undefined) {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: chatKeys.detail(chatId ?? ""),
    queryFn: () => chatsService.getChat(fetcher, chatId as string),
    enabled: Boolean(chatId),
  });
}

export function useCreateChat() {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChatRequest) => chatsService.createChat(fetcher, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

export function useDeleteChat() {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => chatsService.deleteChat(fetcher, chatId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

export function useSetChatPinned() {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsService.setChatPinned(fetcher, chatId, pinned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}

export function useRenameChat() {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      chatsService.renameChat(fetcher, chatId, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all }),
  });
}
