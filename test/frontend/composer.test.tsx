import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_MESSAGE_TEXT_LENGTH } from "@/contracts/messages";
import type { UseAttachmentsResult } from "@/hooks/use-attachments";

// Composer now (S4) always mounts AttachButton (Popover/Tooltip/Dialog
// chrome around a Clerk-gated attach menu) — none of that is what this
// suite exercises (Composer's own text/send/attachments-plumbing
// behavior), and its @base-ui/react-based primitives aren't safely
// renderable in this workspace's RTL environment (only installed under
// frontend/node_modules, a separate React resolution tree — see the
// react/react-dom/lucide-react aliasing notes in vitest.frontend.config.mts
// for the same class of problem). Stub it out with a plain, focusable
// button so Composer's own layout/behavior around it is unaffected.
vi.mock("@/components/chat/attach-button", () => ({
  AttachButton: () => <button aria-label="Add attachment" type="button" />,
}));

import { Composer } from "@/components/chat/composer";

// Minimal valid stub for the now-required `attachments` prop (S4) — every
// render call needs one, even tests that don't exercise attachment behavior.
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

describe("Composer", () => {
  it("disables send until text is present, and clears/sends on click", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} sending={false} attachments={stubAttachments()} />);

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();

    const textbox = screen.getByRole("textbox", { name: /message/i });
    await user.type(textbox, "hello there");
    expect(sendButton).not.toBeDisabled();

    await user.click(sendButton);
    expect(onSend).toHaveBeenCalledWith("hello there", []);
  });

  it("stays disabled for whitespace-only input", async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} sending={false} attachments={stubAttachments()} />);

    const textbox = screen.getByRole("textbox", { name: /message/i });
    await user.type(textbox, "   ");

    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("sends on Enter and inserts a newline on Shift+Enter instead", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} sending={false} attachments={stubAttachments()} />);

    const textbox = screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
    await user.type(textbox, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(textbox.value).toContain("line one\nline two");

    await user.type(textbox, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("line one\nline two", []);
  });

  it("disables send while a message is already in flight", () => {
    render(<Composer onSend={vi.fn()} sending attachments={stubAttachments()} />);
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("replaces Send with Stop while a run is active, and calls onStop", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <Composer onSend={vi.fn()} sending={false} isRunActive onStop={onStop} attachments={stubAttachments()} />,
    );

    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: /stop generating/i });
    expect(stopButton).not.toBeDisabled();

    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("disables Stop, marks aria-busy, and swaps in the 'Stopping generation…' label while isStopping (composer.tsx:116-125)", () => {
    render(
      <Composer
        onSend={vi.fn()}
        sending={false}
        isRunActive
        isStopping
        onStop={vi.fn()}
        attachments={stubAttachments()}
      />,
    );

    const stopButton = screen.getByRole("button", { name: /stopping generation/i });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute("aria-busy", "true");
    // Confirms the icon actually swaps, not just the label — a spinner
    // (IconLoader2) replaces the static stop-square icon.
    expect(stopButton.querySelector("svg.animate-spin")).toBeInTheDocument();
  });

  it("keeps Stop enabled with the default label/icon when a run is active but not yet isStopping", () => {
    render(
      <Composer onSend={vi.fn()} sending={false} isRunActive onStop={vi.fn()} attachments={stubAttachments()} />,
    );

    const stopButton = screen.getByRole("button", { name: /^stop generating$/i });
    expect(stopButton).not.toBeDisabled();
    expect(stopButton).toHaveAttribute("aria-busy", "false");
    expect(stopButton.querySelector("svg.animate-spin")).not.toBeInTheDocument();
  });

  it("does not send while a run is active, even with text present", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <Composer onSend={onSend} sending={false} isRunActive onStop={vi.fn()} attachments={stubAttachments()} />,
    );

    const textbox = screen.getByRole("textbox", { name: /message/i });
    await user.type(textbox, "hello there{Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("marks the textarea aria-invalid and announces the counter via aria-live when over the length limit", () => {
    render(<Composer onSend={vi.fn()} sending={false} attachments={stubAttachments()} />);
    const textbox = screen.getByRole("textbox", { name: /message/i });

    fireEvent.change(textbox, { target: { value: "a".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) } });

    expect(textbox).toHaveAttribute("aria-invalid", "true");
    const counter = screen.getByText(/message is too long/i);
    expect(counter).toHaveAttribute("aria-live", "polite");
    expect(counter).toHaveAttribute("role", "status");
  });

  it("gives the textarea vertical breathing room instead of p-0, so the first/last line's text isn't clipped (observed live: ascender of the top and bottom line cut off with p-0)", () => {
    render(<Composer onSend={vi.fn()} sending={false} attachments={stubAttachments()} />);
    const textbox = screen.getByRole("textbox", { name: /message/i });
    expect(textbox.className).toContain("py-1");
    expect(textbox.className).not.toMatch(/(^|\s)p-0(\s|$)/);
  });
});
