"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "@/components/chat/message-bubble";
import { StreamingMessage, type LiveToolState } from "@/components/chat/streaming-message";
import { ScrollToBottomButton } from "@/components/chat/scroll-to-bottom-button";
import { ApprovalOverlay } from "@/components/chat/approval-overlay";
import { useMessagesList } from "@/hooks/use-messages";
import type { AgentRunDTO } from "@/contracts/runs";
import type { WaitpointDTO, RespondToWaitpointRequest } from "@/contracts/waitpoints";
import type { StreamedSegment } from "@/lib/run-status";

// Distance (px) from the bottom of the scroll container within which the
// view still counts as "at the bottom" for auto-follow purposes.
const NEAR_BOTTOM_THRESHOLD_PX = 100;

interface MessageListProps {
  chatId: string;
  /** The chat's currently-active run, if any (from useActiveRun). */
  activeRun?: AgentRunDTO | null;
  streamedText?: string;
  streamedTools?: LiveToolState[];
  streamedSegments?: StreamedSegment[];
  /** S6 §7.7 — the most recently terminated run's server-owned error, retained after `activeRun` unmounts. */
  lastRunError?: { assistantMessageId: string | null; errorCode: string | null; errorMessage: string | null } | null;
  /** S6 §7.7 — re-sends a prior user turn's content as a new run. */
  onRetry?: (text: string, attachmentIds: string[]) => void;
  /** S6 §7.8 — the active run's pending approval/clarification, if any. */
  pendingWaitpoint?: WaitpointDTO | null;
  onRespondToWaitpoint?: (waitpointId: string, body: RespondToWaitpointRequest) => Promise<unknown>;
}

export function MessageList({
  chatId,
  activeRun,
  streamedText,
  streamedTools,
  streamedSegments,
  lastRunError,
  onRetry,
  pendingWaitpoint,
  onRespondToWaitpoint,
}: MessageListProps) {
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useMessagesList(chatId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Mirrors isNearBottom for synchronous reads inside the scroll-driven
  // effect below, without making that effect re-run on every scroll tick.
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [isNearBottom, setIsNearBottom] = useState(true);
  // Set right before fetchNextPage() and consumed by the layout effect below
  // to keep the viewport anchored when older messages are prepended above
  // the current scroll position — the virtualizer repositions every row via
  // translateY, so unlike plain DOM growth, native scroll anchoring doesn't
  // handle this for us.
  const pendingOlderLoadRef = useRef<number | null>(null);

  // Newest-first pages from the API; reverse to render oldest-to-newest.
  // The active run's own assistant message (if it's landed in a fetched
  // page yet) is excluded — StreamingMessage renders its live text in its
  // place so the same turn never appears twice.
  const messages = (data?.pages.flatMap((p) => p.items) ?? [])
    .slice()
    .reverse()
    .filter((message) => message.id !== activeRun?.assistantMessageId);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    // Row height varies with content (markdown, tool cards, attachments);
    // measureElement below replaces this estimate with the real height once
    // a row mounts, so streamed/growing content never staleishes a cached
    // size — see requirement 3.
    estimateSize: () => 96,
    getItemKey: (index) => messages[index].id,
    overscan: 8,
    // measureElement's ref callback runs during React's commit phase, which
    // React 19 treats as "already rendering" — the default `useFlushSync:
    // true` wraps its re-render in flushSync() and triggers "flushSync was
    // called from inside a lifecycle method". A plain batched re-render
    // (this library's own documented opt-out) avoids that without losing
    // anything: the resize is still applied on the very next render.
    useFlushSync: false,
  });

  function loadOlderMessages() {
    pendingOlderLoadRef.current = scrollContainerRef.current?.scrollHeight ?? null;
    fetchNextPage();
  }

  // Runs after the DOM reflects the newly-prepended older page; adjusts
  // scrollTop by the height that was just added above the fold so the
  // messages the user was already looking at don't jump.
  useLayoutEffect(() => {
    const prevHeight = pendingOlderLoadRef.current;
    if (prevHeight == null) return;
    const el = scrollContainerRef.current;
    if (el) {
      const delta = el.scrollHeight - prevHeight;
      if (delta > 0) el.scrollTop += delta;
    }
    pendingOlderLoadRef.current = null;
  }, [data?.pages.length]);

  function updateNearBottom() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;
    setIsNearBottom(nearBottom);
  }

  function scrollToBottom() {
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }

  useEffect(() => {
    // Sending your own message is an explicit user action — always follow
    // it to the bottom, even if the user had scrolled up to read history.
    const lastMessage = messages[messages.length - 1];
    const isNewOwnMessage = messages.length > prevMessageCountRef.current && lastMessage?.role === "user";
    prevMessageCountRef.current = messages.length;
    if (isNewOwnMessage) {
      isNearBottomRef.current = true;
      setIsNearBottom(true);
    }
    // Otherwise, only auto-follow new messages/streamed tokens while the
    // user is already near the bottom — never yank them away from history
    // they scrolled up to read (reference behavior, S9 realtime UX).
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
    // Streamed text growing must also re-trigger the scroll check — not
    // just a change in the number of persisted messages. `messages` itself
    // is deliberately excluded: it's a new array reference every render, and
    // only its length (or streamed text growing) should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, streamedText?.length, streamedTools?.length]);

  // Height growth that isn't captured by the deps above — a tool card
  // expanding, an image finishing load, markdown re-layout — must still
  // re-trigger the follow-to-bottom while the user is near the bottom.
  // No ResizeObserver exists elsewhere in the codebase; this is the first.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        bottomRef.current?.scrollIntoView({ block: "end" });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-[var(--layout-chat-content-width)] flex-1 flex-col gap-3 p-4">
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={updateNearBottom}
      // Scroll container spans the full content width so the scrollbar
      // renders at the far edge of the pane, not the edge of the centered
      // column — reference DOM, S-fidelity-ui.md Part 3.
      className="scrollbar-thin flex-1 overflow-y-auto overflow-x-hidden"
    >
      <div ref={contentRef} className="mx-auto flex w-full max-w-[var(--layout-chat-content-width)] flex-col gap-3 p-4">
        {hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="mx-auto"
            onClick={loadOlderMessages}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load older messages"}
          </Button>
        )}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const message = messages[virtualRow.index];
            const i = virtualRow.index;
            // S6 §7.7 — retry re-sends the user turn that produced this
            // (failed/cancelled) assistant message; that user message is
            // always the immediately preceding one in turn order.
            const precedingUserMessage = message.role === "assistant" ? messages[i - 1] : undefined;
            const canRetry =
              message.role === "assistant" &&
              (message.status === "failed" || message.status === "cancelled") &&
              precedingUserMessage?.role === "user" &&
              Boolean(onRetry);
            const precedingText = precedingUserMessage?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n\n");
            return (
              <div
                key={message.id}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="pb-3"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageBubble
                  message={message}
                  errorMessage={message.id === lastRunError?.assistantMessageId ? lastRunError.errorMessage : undefined}
                  onRetry={
                    canRetry
                      ? () => onRetry!(precedingText ?? "", precedingUserMessage!.attachments.map((a) => a.id))
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
        {activeRun && (
          <StreamingMessage
            text={streamedText ?? ""}
            tools={streamedTools}
            segments={streamedSegments}
            // Pre-first-token shell: a run has started but nothing has streamed
            // yet — no text, no tool call, AND no reasoning delta either (a
            // reasoning-only round must unmask its own "Reasoned" step
            // instead of staying on this shell — see streamedSegments, which
            // is non-empty the moment any reasoning/text/tool part arrives).
            // A tool-first round (the model calls a tool before any prose,
            // the normal case) must not stay on this shell just because text
            // is still empty — see StreamingMessage's own isThinking
            // handling. Transport health never affects this — the reference
            // product shows no reconnect/error UI (see StreamingMessage).
            isThinking={!streamedSegments?.length && !streamedText && !streamedTools?.length}
          />
        )}
        {onRespondToWaitpoint && (
          // Keyed on the waitpoint's own id (S6 bug fix): this call site never
          // unmounts on its own, so ApprovalOverlay's local `pending`/
          // `answer`/`error` state otherwise survives across an entirely
          // different waitpoint replacing a resolved one within the same
          // run (e.g. a second ask_user question later in the same turn) —
          // the input rendered permanently disabled with the PREVIOUS
          // waitpoint's already-submitted answer still in it, since nothing
          // ever reset `pending` back to false on the success path. Forcing
          // a remount on id change is what actually resets that state.
          <ApprovalOverlay key={pendingWaitpoint?.id ?? "none"} waitpoint={pendingWaitpoint ?? null} onRespond={onRespondToWaitpoint} />
        )}
      </div>
      <div ref={bottomRef} />
      {!isNearBottom && <ScrollToBottomButton onClick={scrollToBottom} />}
    </div>
  );
}
