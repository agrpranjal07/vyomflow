"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { isInsufficientCredits } from "@/lib/credit-errors";
import * as runsService from "@/services/runs";
import { messageKeys } from "@/hooks/use-messages";
import { chatKeys } from "@/hooks/use-chats";
import { creditKeys } from "@/hooks/use-credits";
import { useCreditPaywall } from "@/components/credits/paywall-provider";

/**
 * The single send path (S2 implementation plan §L) — replaces both the old
 * `useSendMessage` mutation and empty-state.tsx's direct
 * `messagesService.sendMessage` call, since both now need to learn about
 * the created run (chatId/message/run/realtime), not just persist text.
 */
export function useSendTurn(chatId: string) {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  const { open: openPaywall } = useCreditPaywall();

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
      if (isInsufficientCredits(error)) {
        openPaywall("message");
        queryClient.invalidateQueries({ queryKey: creditKeys.all });
      }
    },
  });
}
