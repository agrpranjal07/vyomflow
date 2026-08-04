import { useEffect, useRef, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseAttachmentsResult } from "@/hooks/use-attachments";

// Same rationale as composer.test.tsx's own mock — AttachButton's
// @base-ui/react chrome isn't safely renderable in this workspace's RTL
// environment.
vi.mock("@/components/chat/attach-button", () => ({
  AttachButton: () => <button aria-label="Add attachment" type="button" />,
}));

import { Composer } from "@/components/chat/composer";

function stubAttachments(overrides: Partial<UseAttachmentsResult> = {}): UseAttachmentsResult {
  return {
    items: [],
    addFiles: vi.fn(),
    addExisting: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    reset: vi.fn(),
    readyAttachmentIds: [],
    hasUploading: false,
    ...overrides,
  };
}

/**
 * Regression harness — mirrors page.tsx's real (chat-page.tsx) call site:
 * a single ChatPage component instance is reused across a client-side
 * navigation between two chats (Next.js does not remount the page merely
 * because the `chatId` route param changed), so Composer's local draft
 * `text` and the page-owned `attachments` hook's local `items` both used to
 * silently survive a chat switch — chat A's draft/attachments would appear,
 * and could be sent, under chat B. The fix: `key={chatId}` on Composer (its
 * own local state resets fresh), and an explicit chatId-change effect that
 * calls `attachments.reset()` (its state lives one level up, in the page
 * itself, so a child key can't reset it).
 */
function Harness({ chatId, onAttachmentsReset }: { chatId: string; onAttachmentsReset: () => void }) {
  const attachments = stubAttachments({ reset: onAttachmentsReset });
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current === chatId) return;
    prevChatIdRef.current = chatId;
    attachments.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  return <Composer key={chatId} onSend={vi.fn()} sending={false} attachments={attachments} />;
}

function SwitchableHarness() {
  const [chatId, setChatId] = useState("chat-a");
  const onAttachmentsReset = vi.fn();
  return (
    <>
      <button type="button" onClick={() => setChatId("chat-b")}>
        switch chat
      </button>
      <Harness chatId={chatId} onAttachmentsReset={onAttachmentsReset} />
    </>
  );
}

describe("chat switch — Composer draft and attachments must not leak across chats", () => {
  it("clears the composer's draft text when the chatId changes (regression: page.tsx never remounts on a param-only navigation)", async () => {
    const user = userEvent.setup();
    render(<SwitchableHarness />);

    const textbox = screen.getByRole("textbox", { name: /message/i });
    await user.type(textbox, "draft for chat A");
    expect(textbox).toHaveValue("draft for chat A");

    await user.click(screen.getByRole("button", { name: "switch chat" }));

    const freshTextbox = screen.getByRole("textbox", { name: /message/i });
    expect(freshTextbox).toHaveValue("");
  });

  it("calls attachments.reset() exactly once when chatId changes, and not on an unrelated re-render", async () => {
    const onAttachmentsReset = vi.fn();
    const { rerender } = render(<Harness chatId="chat-a" onAttachmentsReset={onAttachmentsReset} />);
    expect(onAttachmentsReset).not.toHaveBeenCalled();

    // Re-render with the same chatId (e.g. a parent state update unrelated
    // to navigation) must not spuriously reset attachments.
    rerender(<Harness chatId="chat-a" onAttachmentsReset={onAttachmentsReset} />);
    expect(onAttachmentsReset).not.toHaveBeenCalled();

    rerender(<Harness chatId="chat-b" onAttachmentsReset={onAttachmentsReset} />);
    expect(onAttachmentsReset).toHaveBeenCalledTimes(1);
  });
});
