"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth, useClerk } from "@clerk/nextjs";
import { Composer } from "@/components/chat/composer";
import { Mascot } from "@/components/brand/mascot";
import { EmptyStateClock } from "@/components/chat/empty-state-clock";
import { useCreateChat, chatKeys } from "@/hooks/use-chats";
import { useApiClient } from "@/hooks/use-api-client";
import { useAttachments } from "@/hooks/use-attachments";
import * as runsService from "@/services/runs";
import { messageKeys } from "@/hooks/use-messages";

// Matches the observed live-product empty state (recon-findings.md):
// centered icon, "Your AI worker" headline, subheading, composer below.
export function EmptyState() {
  const router = useRouter();
  const createChat = useCreateChat();
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  const { isSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  // Chat-create and first-send are two independent backend calls; a retry
  // after a mid-sequence failure must resume against the chat already
  // created rather than creating another orphaned empty one (audit finding
  // frontend #3 — no send-level idempotency key exists to dedupe the send
  // itself, so this only closes the orphan-chat half of the gap).
  const pendingChatIdRef = useRef<string | null>(null);

  // Only the first *send* creates the chat — attaching a file must not.
  // The attachment hook gets a read-only resolver (never creates); send
  // uses `ensureChatId`, which creates once and is reused by any later
  // send in the same still-pending chat.
  const ensureChatId = useCallback(async () => {
    const chatId = pendingChatIdRef.current ?? (await createChat.mutateAsync({})).id;
    pendingChatIdRef.current = chatId;
    return chatId;
  }, [createChat]);
  const getChatIdForAttachments = useCallback(async () => pendingChatIdRef.current ?? undefined, []);
  const attachments = useAttachments(getChatIdForAttachments);

  async function handleFirstMessage(text: string, attachmentIds: string[]) {
    // Guest-accessible shell: sending is the auth boundary, not page view.
    // Open Clerk's in-page sign-in modal and let the composer's own
    // catch-block restore the typed draft (no toast — this isn't a failure).
    if (!isSignedIn) {
      openSignIn();
      throw new Error("Sign-in required");
    }
    try {
      const chatId = await ensureChatId();
      await runsService.sendTurn(fetcher, chatId, {
        content: text ? [{ type: "text", text }] : [],
        attachments: attachmentIds.map((id) => ({ id })),
      });
      pendingChatIdRef.current = null;
      queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) });
      queryClient.invalidateQueries({ queryKey: chatKeys.all });
      router.push(`/c/${chatId}`);
    } catch (err) {
      toast.error("Couldn't start a new chat — try again.");
      throw err;
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
      <Mascot />
      <EmptyStateClock />
      {/* Heading/subtext type scale measured (S-fidelity-ui.md §2.1). */}
      <div className="space-y-1">
        <h1 className="text-2xl leading-8 font-bold text-text-primary">Your AI worker</h1>
        <p className="text-sm leading-6 font-medium text-text-secondary">Work at the speed of thought.</p>
      </div>
      {/* Composer owns its own max-width via --layout-chat-content-width — no separate constraint here. */}
      <div className="w-full">
        <Composer
          onSend={handleFirstMessage}
          sending={createChat.isPending}
          autoFocus
          placeholder="Assign a task or ask anything…"
          attachments={attachments}
        />
      </div>
    </div>
  );
}
