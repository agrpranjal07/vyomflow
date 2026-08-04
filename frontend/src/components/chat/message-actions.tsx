"use client";

import { useEffect, useState } from "react";
import { IconCopy, IconGitBranch, IconThumbUp, IconThumbDown, IconCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// `toLocaleTimeString`/`toLocaleDateString` resolve the runtime's local
// timezone, which can differ between the server (SSR render) and the client
// (hydration), producing a hydration mismatch even with an explicit locale.
// Rendering an empty string until after mount — then formatting client-side
// only — keeps the intended local display without the mismatch.
//
// Shows a bare time ("11:00 PM") for a message from today, and a bare date
// ("Aug 20") for one from an earlier day — never both, and never a relative
// "N days ago" — matching the reference's message-timestamp behavior.
function useLocalTimestamp(createdAt: string): string {
  const [text, setText] = useState("");
  useEffect(() => {
    // Deferred a tick (react-hooks/set-state-in-effect) — same pattern used
    // in use-active-run.ts: a setState call synchronous within the effect
    // body itself is flagged even when harmless here.
    queueMicrotask(() => {
      const date = new Date(createdAt);
      const now = new Date();
      const isSameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
      setText(
        isSameDay
          ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      );
    });
  }, [createdAt]);
  return text;
}

/**
 * Action row below a completed assistant message (S-fidelity-ui.md §2.4:
 * 18×18 icons, left-aligned, timestamp). Copy is real; fork/thumbs are
 * visual-only affordances — those need backend endpoints that don't exist
 * yet (out of scope for this styling pass).
 */
export function MessageActions({ text, createdAt }: { text: string; createdAt: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — no destructive fallback needed.
    }
  }

  const time = useLocalTimestamp(createdAt);

  return (
    <div className="mt-1 flex items-center gap-3 text-text-secondary">
      <button type="button" onClick={handleCopy} aria-label="Copy message" className="hover:text-text-primary">
        {copied ? <IconCheck className="size-[18px]" /> : <IconCopy className="size-[18px]" />}
      </button>
      <button type="button" disabled aria-label="Branch from here" className="hover:text-text-primary">
        <IconGitBranch className="size-[18px]" />
      </button>
      <button type="button" disabled aria-label="Good response" className="hover:text-text-primary">
        <IconThumbUp className="size-[18px]" />
      </button>
      <button type="button" disabled aria-label="Bad response" className="hover:text-text-primary">
        <IconThumbDown className="size-[18px]" />
      </button>
      <span className={cn("text-xs")}>{time}</span>
    </div>
  );
}

/**
 * Timestamp + copy affordance under a user's own message bubble — hidden
 * until the row is hovered (.claude/evidence/chat--user-message-hover-
 * actions--desktop.png: reference reveals time + copy only on hover, right-
 * aligned under the bubble; no branch/thumbs on the user's own message).
 * Requires a `group` class on the row ancestor MessageBubble renders this
 * inside.
 */
export function UserMessageActions({ text, createdAt }: { text: string; createdAt: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — no destructive fallback needed.
    }
  }

  const time = useLocalTimestamp(createdAt);

  return (
    <div className="mt-1 flex items-center gap-1.5 text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <span className="text-xs">{time}</span>
      <button type="button" onClick={handleCopy} aria-label="Copy message" className="hover:text-text-primary">
        {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
      </button>
    </div>
  );
}
