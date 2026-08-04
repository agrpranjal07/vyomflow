"use client";

import { useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { IconChevronDown, IconCirclePlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SquareCheckbox } from "@/components/ui/square-checkbox";
import { ChatListSection } from "@/components/chat/chat-list-section";
import { ChatListItem } from "@/components/chat/chat-list-item";
import { DeleteChatDialog } from "@/components/chat/delete-chat-dialog";
import { useChatsList, useDeleteChat, useRenameChat, useSetChatPinned } from "@/hooks/use-chats";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import type { ChatDTO } from "@/contracts/chats";

const MIN_SEARCH_CHARS = 3;

/**
 * Standalone Tasks page (reference: the reference product's /chat/recent page, reached from
 * the sidebar's "Tasks" nav row). Every value below (container max-width,
 * header row, search bar, row hover/typography, "Filter by"/"Select tasks"
 * chrome) is DOM/computed-style measured live against the reference, not
 * estimated — see .claude/evidence/reference-tasks-page-desktop.md.
 */
export default function TasksPage() {
  const router = useRouter();
  const params = useParams<{ chatId?: string }>();
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ChatDTO | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 300);
  const trimmedQuery = debouncedQuery.trim();
  // Reference: below 3 characters shows a hint instead of running a search —
  // matches its own "Type 3+ characters to search" copy verbatim.
  const isSearching = trimmedQuery.length >= MIN_SEARCH_CHARS;
  const belowMinChars = trimmedQuery.length > 0 && trimmedQuery.length < MIN_SEARCH_CHARS;

  const pinnedList = useChatsList({ pinned: true });
  const mainList = useChatsList(isSearching ? { q: trimmedQuery } : {});

  const deleteChat = useDeleteChat();
  const setPinned = useSetChatPinned();
  const renameChat = useRenameChat();

  const pinnedChats = useMemo(() => pinnedList.data?.pages.flatMap((p) => p.items) ?? [], [pinnedList.data]);
  const pinnedIds = useMemo(() => new Set(pinnedChats.map((c) => c.id)), [pinnedChats]);

  const mainChats = mainList.data?.pages.flatMap((p) => p.items) ?? [];
  const recentChats = isSearching ? mainChats : mainChats.filter((c) => !pinnedIds.has(c.id));
  // Search results (mainChats, when isSearching) already include any
  // pinned matches — don't also splice in the unfiltered pinnedChats list.
  const allVisibleChats = isSearching ? mainChats : [...pinnedChats, ...recentChats];
  const resultCount = allVisibleChats.length;

  function handleTogglePin(chat: ChatDTO) {
    setPinned.mutate(
      { chatId: chat.id, pinned: !chat.pinnedAt },
      { onError: () => toast.error("Couldn't update pin — try again.") },
    );
  }

  function handleRename(chat: ChatDTO, title: string) {
    renameChat.mutate({ chatId: chat.id, title }, { onError: () => toast.error("Couldn't rename chat — try again.") });
  }

  function handleConfirmDelete() {
    if (!pendingDelete) return;
    const chat = pendingDelete;
    setPendingDelete(null);
    deleteChat.mutate(chat.id, {
      onSuccess: () => {
        if (params.chatId === chat.id) router.push("/");
      },
      onError: () => toast.error("Couldn't delete chat — try again."),
    });
  }

  function toggleSelectionMode() {
    setSelectionMode((v) => !v);
    setSelectedIds(new Set());
  }

  function toggleSelect(chat: ChatDTO) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(chat.id)) next.delete(chat.id);
      else next.add(chat.id);
      return next;
    });
  }

  const allSelected = allVisibleChats.length > 0 && allVisibleChats.every((c) => selectedIds.has(c.id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allSelected) return new Set();
      const next = new Set(prev);
      allVisibleChats.forEach((c) => next.add(c.id));
      return next;
    });
  }

  async function confirmBulkDelete() {
    const ids = Array.from(selectedIds);
    setConfirmingBulkDelete(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
    const results = await Promise.allSettled(ids.map((id) => deleteChat.mutateAsync(id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) toast.error(`Couldn't delete ${failed} of ${ids.length} chats — try again.`);
    if (ids.includes(params.chatId ?? "")) router.push("/");
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1472px] flex-1 flex-col overflow-hidden px-8 py-6">
      <div className="shrink-0 pb-5">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[30px] font-bold leading-9 text-text-primary">Tasks</h1>
          <div className="flex items-center gap-2">
            {/* Non-interactive: "All" is the only real filter dimension this
                app has today, so the dropdown has one truthful option rather
                than fabricating filter categories that don't exist. */}
            <Button
              type="button"
              variant="outline"
              disabled
              className="h-9 gap-1.5 rounded-[10px] border-[#ededed] bg-[#fafafa] px-3 text-sm font-medium text-text-primary disabled:opacity-100"
            >
              Filter by <span className="font-medium">All</span>
              <IconChevronDown className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={toggleSelectionMode}
              className={cn(
                "h-9 rounded-[10px] border-[#ededed] bg-[#fafafa] px-3 text-sm font-medium text-text-primary",
                selectionMode && "bg-accent",
              )}
            >
              {selectionMode ? "Cancel" : "Select tasks"}
            </Button>
            <Button
              onClick={() => router.push("/")}
              className="h-9 shrink-0 gap-[7px] rounded-pill bg-[linear-gradient(rgb(59,59,59),rgb(43,43,43))] px-3.5 text-sm font-medium text-[#f7f7f7] hover:opacity-90"
            >
              <IconCirclePlus className="size-3.5" />
              New task
            </Button>
          </div>
        </div>
        <div className="relative mt-4">
          <IconSearch className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-[#919191]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks..."
            aria-label="Search tasks"
            className="h-[34px] w-full rounded-pill bg-[#f7f7f7] px-10 text-sm font-normal text-[#181818] outline-none placeholder:text-[#919191]"
          />
        </div>
        {belowMinChars && <p className="mt-2 text-sm text-text-secondary">Type 3+ characters to search</p>}
        {isSearching && <p className="mt-2 text-sm text-text-secondary">{resultCount} results</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isSearching ? (
          mainList.isLoading ? null : allVisibleChats.length === 0 ? (
            <p className="px-1 py-1.5 text-sm text-text-secondary">No chats match your search.</p>
          ) : (
            <div className="space-y-0.5">
              {allVisibleChats.map((chat) => (
                <ChatListItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === params.chatId}
                  variant="page"
                  selectionMode={selectionMode}
                  selected={selectedIds.has(chat.id)}
                  onToggleSelect={toggleSelect}
                  onTogglePin={handleTogglePin}
                  onRename={handleRename}
                  onDelete={setPendingDelete}
                />
              ))}
            </div>
          )
        ) : (
          <>
            {pinnedChats.length > 0 && (
              <ChatListSection
                title="Pinned tasks"
                chats={pinnedChats}
                loading={pinnedList.isLoading}
                activeId={params.chatId}
                collapsible
                labelTone="primary"
                itemVariant="page"
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onTogglePin={handleTogglePin}
                onRename={handleRename}
                onDelete={setPendingDelete}
              />
            )}
            <ChatListSection
              title="Recent tasks"
              chats={recentChats}
              loading={mainList.isLoading}
              emptyLabel="No chats yet — start one above."
              activeId={params.chatId}
              collapsible
              itemVariant="page"
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onTogglePin={handleTogglePin}
              onRename={handleRename}
              onDelete={setPendingDelete}
            />
            {mainList.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="mb-2 w-full"
                onClick={() => mainList.fetchNextPage()}
                disabled={mainList.isFetchingNextPage}
              >
                {mainList.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </div>

      {/* Bulk selection bar — same 84px/white/1px-#ededed-top-border chrome
          as the Media Library's own selection bar (reference-media-library-desktop.md);
          Tasks has no download concept, so only select-all + delete. */}
      {selectionMode && selectedIds.size > 0 && (
        <div className="flex h-[84px] shrink-0 items-center justify-between border-t border-[#ededed] bg-white px-10">
          <div className="flex items-center gap-3">
            <SquareCheckbox checked={allSelected} onClick={toggleSelectAll} />
            <span className="text-sm text-text-primary">{selectedIds.size} Selected</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-pill text-[#5e5e5e]"
            >
              Clear Selection
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setConfirmingBulkDelete(true)}
            aria-label="Delete selected"
            className="size-7 rounded-full bg-white text-destructive hover:bg-black/5"
          >
            <IconTrash className="size-4" />
          </Button>
        </div>
      )}

      <Dialog open={confirmingBulkDelete} onOpenChange={setConfirmingBulkDelete}>
        <DialogContent showCloseButton={false} className="w-[512px] max-w-[90vw] gap-4 rounded-2xl bg-white p-6 ring-0">
          <p className="text-lg font-semibold text-text-primary">Delete Selected Tasks</p>
          <p className="text-sm leading-5 text-[#585858]">
            Are you sure you want to delete {selectedIds.size === 1 ? "this task" : `these ${selectedIds.size} tasks`}?
            This can&rsquo;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-pill border-[#ededed] text-[#181818] hover:bg-black/5"
              onClick={() => setConfirmingBulkDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-9 rounded-pill bg-[#b42318] text-[#f7f7f7] hover:bg-[#b42318]/90"
              onClick={confirmBulkDelete}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <DeleteChatDialog chat={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={handleConfirmDelete} />
    </div>
  );
}
