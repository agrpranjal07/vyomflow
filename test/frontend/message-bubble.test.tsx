import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "@/components/chat/message-bubble";
import type { MessageDTO } from "@/contracts/messages";

// A same-day timestamp, built relative to the real clock rather than a
// fixed literal, so the timestamp renders a time (not a date) regardless of
// when the test runs — see message-actions.tsx's day-boundary logic.
const todayIso = new Date().toISOString();

function userMessage(overrides: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: "m1",
    chatId: "c1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    attachments: [],
    status: "complete",
    createdAt: todayIso,
    updatedAt: todayIso,
    ...overrides,
  };
}

describe("MessageBubble — user message hover actions", () => {
  it("renders a hidden-until-hover timestamp + copy affordance under a completed user message (reference: chat--user-message-hover-actions--desktop.png)", async () => {
    const { container } = render(<MessageBubble message={userMessage()} />);
    expect(container.querySelector(".group")).toBeInTheDocument();
    const actions = container.querySelector(".group-hover\\:opacity-100");
    expect(actions).toBeInTheDocument();
    expect(actions).toHaveClass("opacity-0");
    expect(screen.getByLabelText("Copy message")).toBeInTheDocument();
    // Time is rendered client-side only, a tick after mount (avoids an
    // SSR/client timezone hydration mismatch) — await it.
    expect(await screen.findByText(/\d{1,2}:\d{2}\s?(AM|PM)/i)).toBeInTheDocument();
  });

  it("does not render the hover affordance for a non-complete (e.g. failed) user message", () => {
    const { container } = render(<MessageBubble message={userMessage({ status: "failed" })} />);
    expect(container.querySelector(".group-hover\\:opacity-100")).not.toBeInTheDocument();
  });
});
