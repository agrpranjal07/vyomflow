"use client";

import { use, useCallback, useEffect, useRef } from "react";
import { notFound, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth, useClerk } from "@clerk/nextjs";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { useChat } from "@/hooks/use-chats";
import { useSendTurn } from "@/hooks/use-send-turn";
import { useActiveRun } from "@/hooks/use-active-run";
import { useAttachments } from "@/hooks/use-attachments";
import { ApiError } from "@/lib/api-client";

export default function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = use(params);
  const router = useRouter();
  const chat = useChat(chatId);
  const sendTurn = useSendTurn(chatId);
  const activeRun = useActiveRun(chatId, chat.data?.activeRunId);
  const attachments = useAttachments(useCallback(async () => chatId, [chatId]));
  const { isSignedIn } = useAuth();
  const { openSignIn } = useClerk();

  // Next.js reuses this same page component instance across a client-side
  // navigation between two chats (only the `chatId` param changes, same
  // route position) — attachments.items is local state, so without this it
  // silently carried chat A's in-flight/ready attachments (and their ids)
  // into chat B's send. Composer's own draft text is reset separately below
  // via `key={chatId}`.
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current === chatId) return;
    prevChatIdRef.current = chatId;
    attachments.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const chatErrorStatus = chat.isError && chat.error instanceof ApiError ? chat.error.status : undefined;

  if (chatErrorStatus === 404) {
    notFound();
  }

  useEffect(() => {
    // A guest (or a signed-in user who doesn't own this chat) hit the
    // backend's independent Bearer-token boundary — bounce to the
    // guest-browsable shell instead of showing a raw error page.
    if (chatErrorStatus === 401 || chatErrorStatus === 403) {
      router.replace("/");
    }
  }, [chatErrorStatus, router]);

  async function handleSend(text: string, attachmentIds: string[]) {
    // Guest-accessible shell: sending is the auth boundary, not page view —
    // open Clerk's in-page modal and let Composer restore the draft.
    if (!isSignedIn) {
      openSignIn();
      throw new Error("Sign-in required");
    }
    let response: Awaited<ReturnType<typeof sendTurn.mutateAsync>>;
    try {
      response = await sendTurn.mutateAsync({ text, attachmentIds });
    } catch (err) {
      // Two tabs open on the same chat can both pass the client-side
      // isRunActive check before either has received the other's realtime
      // run-started event — the backend's partial-unique-index guard is the
      // real source of truth and returns 409 here. Reference-verified copy
      // (.claude/evidence/chat.md) — the losing tab's own UI still syncs to
      // "running" moments later via the realtime event either sender caused.
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Agent is still working", {
          description: "An agent is still working on this chat. Please wait for it to finish before sending another message.",
        });
      } else {
        toast.error("Couldn't send your message — try again.");
      }
      throw err;
    }
    // Starting the realtime subscription is a local, non-retriable side
    // effect distinct from the send itself — a failure here must not be
    // reported as (or trigger draft-restore for) a failed send.
    try {
      activeRun.start(response.run, response.realtime);
    } catch {
      toast.error("Message sent, but live updates couldn't start — reload to see the response.");
    }
  }

  async function handleStop() {
    try {
      await activeRun.cancel();
    } catch {
      toast.error("Couldn't stop the response — try again.");
    }
  }

  // S6 §7.7 — retry is a *new* turn with the original content, not a resume
  // of the dead run (OpenRouter offers no generation resume; consistent with
  // S2-streaming-turn.md's already-established invariant for worker crashes).
  async function handleRetry(text: string, attachmentIds: string[]) {
    try {
      const response = await sendTurn.mutateAsync({ text, attachmentIds });
      activeRun.start(response.run, response.realtime);
    } catch {
      toast.error("Couldn't retry — try again.");
    }
  }

  // Reference has exactly one top bar (AppHeader) and never shows a chat
  // title in it — no separate per-chat header (audit finding #5).
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <MessageList
        chatId={chatId}
        activeRun={activeRun.activeRun}
        streamedText={activeRun.streamedText}
        streamedTools={activeRun.streamedTools}
        streamedSegments={activeRun.streamedSegments}
        lastRunError={activeRun.lastRunError}
        onRetry={handleRetry}
        pendingWaitpoint={activeRun.pendingWaitpoint}
        onRespondToWaitpoint={activeRun.respond}
      />
      <Composer
        // Keyed on chatId — this call site never unmounts on its own
        // (see the attachments.reset() effect above), so Composer's local
        // draft `text` otherwise survives across a chat switch and shows up
        // in the wrong chat's box.
        key={chatId}
        onSend={handleSend}
        sending={sendTurn.isPending}
        autoFocus
        isRunActive={activeRun.isActive}
        isStopping={activeRun.isStopping}
        onStop={handleStop}
        attachments={attachments}
      />
    </div>
  );
}
