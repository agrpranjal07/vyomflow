import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatListItem } from "@/components/chat/chat-list-item";
import type { ChatDTO } from "@/contracts/chats";

// @base-ui/react's Menu primitives duplicate React the same way next/link did (real "@base-ui/react"
// only exists in frontend/node_modules, resolved relative to the importing frontend/src file — no
// alias fixes this the way next/link was fixed since this is a real, per-component UI library, not a
// single shared stub worth aliasing project-wide). This test cares about ChatListItem's rename logic,
// not DropdownMenu's own open/close mechanics, so a trivial always-open stand-in sidesteps the crash.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

function chat(overrides: Partial<ChatDTO> = {}): ChatDTO {
  return {
    id: "c1",
    title: "Merge Videos Tool Request",
    pinnedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatListItem — rename", () => {
  const onRename = vi.fn();

  beforeEach(() => {
    onRename.mockReset();
  });

  function renderItem(overrides: Partial<ChatDTO> = {}) {
    return render(
      <ChatListItem chat={chat(overrides)} active={false} onTogglePin={vi.fn()} onRename={onRename} onDelete={vi.fn()} />,
    );
  }

  it("clicking Rename shows a pre-filled, selected input in place of the title link", () => {
    renderItem();
    fireEvent.click(screen.getByText("Rename"));

    const input = screen.getByLabelText(/rename chat/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("Merge Videos Tool Request");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("commits a trimmed, changed title on Enter", () => {
    renderItem();
    fireEvent.click(screen.getByText("Rename"));

    const input = screen.getByLabelText(/rename chat/i);
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), "New title");
  });

  it("discards the draft on Escape without calling onRename", () => {
    renderItem();
    fireEvent.click(screen.getByText("Rename"));

    const input = screen.getByLabelText(/rename chat/i);
    fireEvent.change(input, { target: { value: "Ignored draft" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Merge Videos Tool Request")).toBeInTheDocument();
  });

  it("does not call onRename when the title is unchanged or emptied", () => {
    renderItem();
    fireEvent.click(screen.getByText("Rename"));
    fireEvent.blur(screen.getByLabelText(/rename chat/i));
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Rename"));
    fireEvent.change(screen.getByLabelText(/rename chat/i), { target: { value: "   " } });
    fireEvent.blur(screen.getByLabelText(/rename chat/i));
    expect(onRename).not.toHaveBeenCalled();
  });
});
