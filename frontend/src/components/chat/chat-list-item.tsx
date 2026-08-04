"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconDots, IconPencil, IconPin, IconPinnedOff, IconTrash } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { SquareCheckbox } from "@/components/ui/square-checkbox";
import type { ChatDTO } from "@/contracts/chats";

export function ChatListItem({
  chat,
  active,
  variant = "sidebar",
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onTogglePin,
  onRename,
  onDelete,
}: {
  chat: ChatDTO;
  active: boolean;
  /** "page" is the full-width Tasks-page row (34px/12px-padding/10px-radius, pin icon + relative time) — live-measured, reference-tasks-page-desktop.md. */
  variant?: "sidebar" | "page";
  /** "Select tasks" bulk mode (page variant only) — row click toggles selection instead of navigating. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (chat: ChatDTO) => void;
  onTogglePin: (chat: ChatDTO) => void;
  onRename: (chat: ChatDTO, title: string) => void;
  onDelete: (chat: ChatDTO) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  function startRenaming() {
    setDraftTitle(chat.title);
    setIsRenaming(true);
  }

  function commitRename() {
    const trimmed = draftTitle.trim();
    setIsRenaming(false);
    if (trimmed && trimmed !== chat.title) {
      onRename(chat, trimmed);
    }
  }

  function cancelRename() {
    setDraftTitle(chat.title);
    setIsRenaming(false);
  }

  const isPage = variant === "page";
  const titleRow = (
    <>
      {isPage && chat.pinnedAt && <IconPin size={12} className="shrink-0 text-text-tertiary" />}
      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      {isPage && (
        <span className="shrink-0 text-xs text-text-tertiary">{formatRelativeTime(chat.updatedAt ?? chat.createdAt)}</span>
      )}
    </>
  );

  return (
    <div
      // Sidebar: 224x34, radius-sm, padding 0 8px, hover:accent — measured, S-fidelity-ui.md §2.4/§2.3.
      // Page: 34px tall (padding "4px 12px"), 10px radius (--radius-sm),
      // hover:surface-thumbnail, title line-height 24px — live-measured
      // DOM/computed-style against the reference product's /chat/recent page,
      // reference-tasks-page-desktop.md.
      className={cn(
        "group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-1 text-sm font-medium",
        isPage
          ? "gap-2 rounded-sm px-3 leading-6 text-text-primary hover:bg-surface-thumbnail"
          : "rounded-sm px-2 text-text-secondary hover:bg-accent",
        active && (isPage ? "bg-surface-thumbnail" : "bg-accent text-text-primary"),
      )}
    >
      {isPage && selectionMode && (
        <SquareCheckbox checked={selected} onClick={() => onToggleSelect?.(chat)} className="shrink-0" />
      )}
      {isRenaming ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5">
          <IconPencil size={14} className="shrink-0 text-text-secondary" />
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            aria-label={`Rename chat "${chat.title}"`}
            className="min-w-0 flex-1 text-sm font-medium text-text-primary outline-none border border-ring bg-background px-1.5 border-2 py-0.5"
          />
        </div>
      ) : isPage && selectionMode ? (
        <button
          type="button"
          onClick={() => onToggleSelect?.(chat)}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
        >
          {titleRow}
        </button>
      ) : (
        <Link href={`/c/${chat.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 truncate" title={chat.title}>
          {titleRow}
        </Link>
      )}
      {!selectionMode && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
                aria-label={`More actions for ${chat.title}`}
              >
                <IconDots size={16} />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onTogglePin(chat)}>
              {chat.pinnedAt ? (
                <>
                  <IconPinnedOff size={16} /> Unpin
                </>
              ) : (
                <>
                  <IconPin size={16} /> Pin
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={startRenaming}>
              <IconPencil size={16} /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(chat)}>
              <IconTrash size={16} /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
