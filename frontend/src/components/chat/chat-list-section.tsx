"use client";

import { useState } from "react";
import { IconChevronUp } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatListItem } from "@/components/chat/chat-list-item";
import type { ChatDTO } from "@/contracts/chats";

/**
 * One labeled group in the sidebar (Pinned / Recent / Results) with its own
 * loading and empty states. `collapsible` sections get a hover-revealed
 * chevron (live-measured: opacity-0 → opacity-100 on header hover/focus,
 * exact class list the reference product's own chat sidebar uses) that toggles the
 * list below — see .claude/evidence/reference-tasks-page-desktop.md.
 * `labelTone` mirrors the reference's own distinction: "Pinned tasks" reads
 * text-primary (darker), "Recent tasks" reads text-secondary (lighter).
 */
export function ChatListSection({
  title,
  chats,
  loading,
  emptyLabel,
  activeId,
  collapsible = false,
  labelTone = "secondary",
  itemVariant = "sidebar",
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onTogglePin,
  onRename,
  onDelete,
}: {
  title: string;
  chats: ChatDTO[];
  loading: boolean;
  emptyLabel?: string;
  activeId?: string;
  collapsible?: boolean;
  labelTone?: "primary" | "secondary";
  itemVariant?: "sidebar" | "page";
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (chat: ChatDTO) => void;
  onTogglePin: (chat: ChatDTO) => void;
  onRename: (chat: ChatDTO, title: string) => void;
  onDelete: (chat: ChatDTO) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const header = (
    <button
      type="button"
      disabled={!collapsible}
      onClick={() => setCollapsed((v) => !v)}
      // Header row itself: measured 12px/400 text, px-2/py-1 hit area — the
      // reference wraps the whole label+chevron as one clickable row, not
      // just the chevron.
      className={cn(
        "group/history-header flex w-full items-center justify-between gap-1 overflow-clip rounded-sm px-0 py-1 text-xs font-normal disabled:cursor-default",
        labelTone === "primary" ? "text-text-primary" : "text-text-secondary",
      )}
    >
      <span className="truncate">{title}</span>
      {collapsible && (
        <IconChevronUp
          size={12}
          className={cn(
            "shrink-0 opacity-0 transition-[opacity,transform] group-hover/history-header:opacity-100 group-focus-visible/history-header:opacity-100",
            collapsed && "rotate-180",
          )}
        />
      )}
    </button>
  );

  if (loading) {
    return (
      <div className="mb-3 space-y-1">
        {header}
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }

  if (chats.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div className="mb-3">
        {header}
        <p className="px-2 py-1.5 text-sm text-text-secondary">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="mb-3 space-y-0.5">
      {header}
      {!collapsed &&
        chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            active={chat.id === activeId}
            variant={itemVariant}
            selectionMode={selectionMode}
            selected={selectedIds?.has(chat.id) ?? false}
            onToggleSelect={onToggleSelect}
            onTogglePin={onTogglePin}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}
