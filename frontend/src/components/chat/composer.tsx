"use client";

import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { IconArrowUp, IconLoader2, IconPlayerStopFilled } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_TEXT_LENGTH } from "@/contracts/messages";
import { AttachButton } from "@/components/chat/attach-button";
import { AttachmentStrip } from "@/components/chat/attachment-strip";
import type { UseAttachmentsResult } from "@/hooks/use-attachments";

export function Composer({
  onSend,
  sending,
  autoFocus,
  isRunActive,
  isStopping,
  onStop,
  placeholder = "Send a message…",
  attachments,
}: {
  onSend: (text: string, attachmentIds: string[]) => void | Promise<void>;
  sending: boolean;
  autoFocus?: boolean;
  /** A run is streaming for this chat — send is replaced by Stop (matches the reference product). */
  isRunActive?: boolean;
  /** Cancel already requested for the active run — disable Stop so a second click can't double-request it. */
  isStopping?: boolean;
  onStop?: () => void | Promise<void>;
  /** Surface-specific placeholder copy (S-fidelity-ui.md: differs empty-state vs. in-chat). */
  placeholder?: string;
  attachments: UseAttachmentsResult;
}) {
  const [text, setText] = useState("");

  const trimmed = text.trim();
  const overLimit = trimmed.length > MAX_MESSAGE_TEXT_LENGTH;
  const hasReadyAttachment = attachments.readyAttachmentIds.length > 0;
  // A chat can only ever have one active run (backend partial-unique
  // index) — sending is disabled, not merely discouraged, while one is
  // already streaming. S4: text is no longer required — a ready attachment
  // alone is a valid send, matching the relaxed backend contract — but a
  // send is blocked while any attachment is still uploading (its id isn't
  // known/ready yet).
  const canSend =
    (trimmed.length > 0 || hasReadyAttachment) &&
    !overLimit &&
    !sending &&
    !isRunActive &&
    !attachments.hasUploading;

  async function handleSend() {
    if (!canSend) return;
    const value = trimmed;
    const attachmentIds = attachments.readyAttachmentIds;
    setText("");
    try {
      await onSend(value, attachmentIds);
      attachments.reset();
    } catch {
      // Submission failed — restore the draft rather than losing it.
      setText(value);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  // Image data pasted from the OS clipboard (e.g. a screenshot) arrives as a
  // File-typed clipboard item, never as text — route it through the same
  // upload path as a picked/dropped file instead of letting the browser
  // drop it silently.
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void attachments.addFiles(files);
  }

  return (
    <div className="bg-background p-3">
      {/* Container geometry measured (S-fidelity-ui.md §2.3/2.4): radius-lg
          (24px), padding 16px/16px/12px, max-width via the shared layout
          token. Focus ring is the measured composer-focus shadow, authored
          as a `.group\/composer:focus-within` rule in globals.css (Tailwind
          doesn't generate a focus-within: variant of a hand-written class
          name), keyed off the `group/composer` marker below. */}
      <div className="group/composer mx-auto flex max-w-[var(--layout-chat-content-width)] flex-col gap-2 rounded-[var(--radius-lg)] px-4 pt-4 pb-3">
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          aria-label="Message"
          aria-invalid={overLimit}
          className="scrollbar-thin max-h-48 min-h-9 resize-none border-0 bg-transparent py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AttachButton
              onFilesSelected={(files) => void attachments.addFiles(files)}
              onLibrarySelect={attachments.addExisting}
              disabled={sending || isRunActive}
            />
            <span
              role="status"
              aria-live="polite"
              className={overLimit ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {overLimit ? `${trimmed.length}/${MAX_MESSAGE_TEXT_LENGTH} — message is too long` : ""}
            </span>
          </div>
          {isRunActive ? (
            <Button
              size="icon"
              variant="destructive"
              className="size-8 shrink-0 rounded-[var(--radius-pill)] disabled:opacity-70"
              onClick={onStop}
              disabled={isStopping}
              aria-busy={isStopping ?? false}
              // UNKNOWN — copy/layout for this pressed state implemented from
              // the plan text ("Stopping generation..."), not re-verified
              // against a live screenshot (browser-policy.md: no Chrome spend
              // for a state we can source from the spec). Flag for a future
              // fidelity pass.
              aria-label={isStopping ? "Stopping generation…" : "Stop generating"}
            >
              {isStopping ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconPlayerStopFilled className="size-3.5" />
              )}
            </Button>
          ) : (
            <Button
              size="icon"
              disabled={!canSend}
              onClick={handleSend}
              aria-label="Send message"
              // Measured: disabled→enabled is a deliberate color flip
              // (--action-primary-*-disabled -> --action-primary-*), not
              // an opacity fade (S-fidelity-ui.md §2.2).
              className={cn(
                "size-8 shrink-0 rounded-[var(--radius-pill)] hover:opacity-90 disabled:opacity-100",
                canSend
                  ? "bg-action-primary-bg text-action-primary-fg"
                  : "bg-action-primary-bg-disabled text-action-primary-fg-disabled",
              )}
            >
              <IconArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
