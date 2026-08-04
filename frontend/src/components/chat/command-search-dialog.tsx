"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { IconMessage, IconSearch } from "@tabler/icons-react";
import { useChatsList } from "@/hooks/use-chats";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

const RESULT_LIMIT = 8;

/**
 * Global Cmd/Ctrl+K-style search — the sidebar's search icon and shortcut
 * open THIS modal, not an inline expand (the reference always uses this
 * dialog for that icon; live-measured DOM/computed-style,
 * .claude/evidence/reference-search-command-palette-desktop.md).
 */
export function CommandSearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const debounced = useDebouncedValue(query, 200);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useChatsList(debounced.trim() ? { q: debounced.trim() } : {}, { enabled: open });
  const chats = useMemo(() => (list.data?.pages.flatMap((p) => p.items) ?? []).slice(0, RESULT_LIMIT), [list.data]);

  // Reset query/selection when the dialog transitions closed -> open, and
  // reset the selected row whenever the search term changes — React's
  // documented "adjusting state on a prop change" pattern (state, not a
  // ref, tracks the previous value) rather than an effect, so it can't
  // cascade an extra render.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }

  const [prevDebounced, setPrevDebounced] = useState(debounced);
  if (debounced !== prevDebounced) {
    setPrevDebounced(debounced);
    setActiveIndex(0);
  }

  // Focus is a DOM side effect, not derived state — belongs in an effect.
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  function goToChat(chatId: string) {
    onOpenChange(false);
    closeSidebar();
    router.push(`/c/${chatId}`);
  }

  function handleNewTask() {
    onOpenChange(false);
    closeSidebar();
    router.push("/");
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, chats.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chat = chats[activeIndex];
      if (chat) goToChat(chat.id);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Transparent + blur(1px), no dark scrim — measured live, differs
            from this app's default DialogOverlay (bg-black/10). */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-transparent backdrop-blur-[1px] duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 w-[512px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-1 text-sm shadow-lg outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <DialogPrimitive.Title className="sr-only">Search tasks</DialogPrimitive.Title>
          <div className="flex h-11 items-center gap-2 px-3">
            <IconSearch size={16} className="shrink-0 text-text-secondary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search"
              aria-label="Search tasks"
              className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium text-text-primary outline-none placeholder:text-text-secondary"
            />
            <span className="shrink-0 rounded-[5px] px-1 text-sm font-medium text-text-secondary">esc</span>
          </div>
          <div className="max-h-[270px] overflow-y-auto rounded-3xl bg-[#f7f7f7] p-1">
            <p className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-text-secondary">Tasks</p>
            {chats.length === 0 ? (
              <p className="px-4 py-2 text-sm text-text-secondary">
                {list.isLoading ? "Searching…" : "No tasks found."}
              </p>
            ) : (
              chats.map((chat, i) => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => goToChat(chat.id)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    "flex h-10 w-full cursor-pointer items-center gap-3 rounded-pill px-4 text-left",
                    i === activeIndex ? "bg-white text-text-primary" : "bg-transparent text-text-secondary",
                  )}
                >
                  <IconMessage size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{chat.title}</span>
                </button>
              ))
            )}
          </div>
          <div className="flex items-center justify-between px-3 pt-1 pb-1">
            <button type="button" onClick={handleNewTask} className="text-sm font-medium text-text-primary">
              New task
            </button>
            <div className="flex items-center gap-1 text-[10px] font-medium text-text-secondary">
              <span className="rounded-[5px] px-1">Ctrl</span>
              <span className="rounded-[5px] px-1">Shift+</span>
              <span className="rounded-[5px] px-1">O</span>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
