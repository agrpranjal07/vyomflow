"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApiClient } from "@/hooks/use-api-client";
import { ApiError } from "@/lib/api-client";
import * as runsService from "@/services/runs";
import { messageKeys } from "@/hooks/use-messages";
import { chatKeys } from "@/hooks/use-chats";
import { creditKeys } from "@/hooks/use-credits";

/**
 * The single send path (S2 implementation plan §L) — replaces both the old
 * `useSendMessage` mutation and empty-state.tsx's direct
 * `messagesService.sendMessage` call, since both now need to learn about
 * the created run (chatId/message/run/realtime), not just persist text.
 */
export function useSendTurn(chatId: string) {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ text, attachmentIds }: { text: string; attachmentIds: string[] }) =>
      runsService.sendTurn(fetcher, chatId, {
        content: text ? [{ type: "text", text }] : [],
        attachments: attachmentIds.map((id) => ({ id })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) });
      queryClient.invalidateQueries({ queryKey: chatKeys.all });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === "INSUFFICIENT_CREDITS") {
        toast.warning(error.message);
        queryClient.invalidateQueries({ queryKey: creditKeys.all });
      }
    },
  });
}
