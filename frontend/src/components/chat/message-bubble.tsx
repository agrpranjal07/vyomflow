import { IconInfoCircle } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { MessageDTO } from "@/contracts/messages";
import { MessageContent } from "@/components/chat/message-content";
import { MessageActions, UserMessageActions } from "@/components/chat/message-actions";
import { bubbleVariants } from "@/components/chat/message-bubble-variants";
import { GeneratedAsset } from "@/components/chat/generated-asset";
import { SentAttachmentThumbnail } from "@/components/chat/sent-attachment-thumbnail";

export function MessageBubble({
  message,
  errorMessage,
  onRetry,
}: {
  message: MessageDTO;
  /** S6 §7.7 — the terminating run's server-owned errorMessage, when this is that run's assistant message. */
  errorMessage?: string | null;
  /** S6 §7.7 — re-sends the original user turn as a new run; undefined when there's nothing to retry. */
  onRetry?: () => void;
}) {
  const isUser = message.role === "user";
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

  // Reference (the reference product's chat page): only the user's own message is a
  // bounded, colored bubble — the assistant's response is plain full-width
  // text with no card/background (.claude/evidence/
  // reference-chat-response-rendered.md). `group` on the row lets the
  // user bubble's own hover-revealed timestamp/copy (UserMessageActions)
  // stay hidden until the row is hovered
  // (.claude/evidence/chat--user-message-hover-actions--desktop.png).
  return (
    <div className={cn("group flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex flex-col", isUser && "items-end")}>
        {/* S4: reference distinguishes attachment count, not just single vs.
            bubble — 2+ attachments float above the bubble, on the plain page
            background, as their own row of small thumbnails; a single
            attachment stays inside the bubble as a full-size GeneratedAsset
            (see the "1" branch below). Assistant messages never carry
            attachments today, so this is a no-op there. */}
        {message.attachments.length > 1 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {message.attachments.map((a) => (
              <SentAttachmentThumbnail key={a.id} attachment={a} />
            ))}
          </div>
        )}
        <div
          className={cn(
            "text-sm",
            // Assistant column gets its 16px horizontal inset from
            // MessageList's own p-4 alone — an extra px-4 here double-applied
            // it and narrowed the text column by 32px (audit finding #16).
            isUser ? bubbleVariants({ tone: "user" }) : "w-full",
            message.status === "failed" && bubbleVariants({ tone: "error" }),
          )}
        >
          {message.attachments.length === 1 && message.attachments[0]!.resultUrl && (
            <div className="mb-1.5">
              <GeneratedAsset url={message.attachments[0]!.resultUrl} className="max-h-56" />
            </div>
          )}
          <MessageContent blocks={message.content} />
          {message.status === "failed" && (
            <>
              <p className={cn("mt-1 text-xs", isUser ? "opacity-80" : "text-destructive")}>
                {isUser ? "Failed to send" : (errorMessage ?? "Response failed — the partial text above was preserved")}
              </p>
              {!isUser && onRetry && (
                <button type="button" onClick={onRetry} className="mt-1 text-xs font-medium text-text-primary">
                  Retry
                </button>
              )}
            </>
          )}
          {message.status === "cancelled" &&
            (isUser ? (
              // Frozen label — user-side cancellation has no reference banner equivalent (S2-streaming-turn.md).
              <p className="mt-1 text-xs text-muted-foreground">Cancelled</p>
            ) : (
              // Terminal "interrupted" banner (chat--generation-stopping--desktop.png, see chat.md's
              // filename-swap note).
              <div className="mt-1 flex items-center justify-between rounded-[var(--radius-sm)] bg-muted px-3 py-2.5 text-xs text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <IconInfoCircle className="size-4" />
                  {errorMessage ?? "Response was interrupted"}
                </span>
                <button
                  type="button"
                  disabled={!onRetry}
                  onClick={onRetry}
                  className="font-medium text-text-primary disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            ))}
        </div>
        {isUser && message.status === "complete" && <UserMessageActions text={text} createdAt={message.createdAt} />}
        {!isUser && message.status === "complete" && <MessageActions text={text} createdAt={message.createdAt} />}
      </div>
    </div>
  );
}
