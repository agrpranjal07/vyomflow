"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { useTheme } from "next-themes";
import { useAuth, useClerk, UserButton } from "@clerk/nextjs";
import {
  IconApiBook,
  IconBooks,
  IconCirclePlus,
  IconCreditCard,
  IconDeviceDesktop,
  IconDotsVertical,
  IconKey,
  IconLayoutSidebar,
  IconMessage,
  IconMoon,
  IconSearch,
  IconSun,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChatListSection } from "@/components/chat/chat-list-section";
import { CommandSearchDialog } from "@/components/chat/command-search-dialog";
import { DeleteChatDialog } from "@/components/chat/delete-chat-dialog";
import { LogoWordmark } from "@/components/brand/logo-wordmark";
import { LogoMark } from "@/components/brand/logo-mark";
import { useChatsList, useDeleteChat, useRenameChat, useSetChatPinned } from "@/hooks/use-chats";
import { useCredits } from "@/hooks/use-credits";
import { useCreditPaywall } from "@/components/credits/paywall-provider";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { formatCredits } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatDTO } from "@/contracts/chats";

// Reference-observed shortcut hint pairs (S-fidelity-ui.md doesn't measure
// these — implementation decision, kept in one place so hint text/tooltips
// can't drift from the actual key handler below).
const SHORTCUT_HINT_SEARCH = "Ctrl K";
const SHORTCUT_HINT_TOGGLE_SIDEBAR = "Ctrl B";
const SHORTCUT_HINT_NEW_TASK = "Ctrl+Shift+O";

// S8: public API/Mintlify docs link (reference sidebar row "API / MCP",
// sidebar.md evidence). External, unauthenticated, opens in a new tab —
// unlike Tasks/Library this never goes through handleNavGuarded. Falls back
// to the live docs site so NEXT_PUBLIC_API_DOCS_URL only needs to be set to
// override it.
const API_DOCS_URL =
  process.env.NEXT_PUBLIC_API_DOCS_URL ?? "https://docs.vyomflow.co.in";

// Icon order matches the reference: system → light → dark (audit finding #12).
const THEME_OPTIONS = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
] as const;

/**
 * Sidebar footer credit block — flat row layout, live-measured against the
 * reference (S7 audit 2026-08-21, dark + light, via Claude-in-Chrome
 * DOM/computed-style inspection, not guessed from a screenshot):
 *   - "Available Credits" label: --text-primary, 12px/400/16px
 *   - value: --text-secondary, 12px/500/16px (the reference renders it as a
 *     link to a usage page; ours links nowhere special, so it's plain text)
 *   - Add Credits button: 32px tall, full width, radius-sm (10px),
 *     var(--credit-cta-gradient-from/-to) background, var(--credit-cta-fg)
 *     text — identical in light and dark (the reference never re-themes it)
 * The reference's green "+15M credits on <date>" renewal pill is
 * deliberately omitted — it reflects the reference product's own subscription/grant
 * schedule, which this app has no backend model for; rendering it would
 * mean inventing an amount and date with no real state behind them
 * (user-confirmed 2026-08-21). Owns its own loading/error/empty state
 * (ui-architecture-policy.md) — no fabricated balance on error/loading,
 * nothing renders instead of a fake "0.00M".
 */
export function SidebarCreditBlock() {
  const { data, isLoading, isError } = useCredits();
  const { open: openPaywall } = useCreditPaywall();

  function handleAddCredits() {
    openPaywall("message");
  }

  return (
    <div className="flex flex-col gap-2 px-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs leading-4 text-text-primary">Available Credits</span>
        {isLoading ? (
          <Skeleton className="h-4 w-11" />
        ) : isError || !data ? null : (
          <span className="text-xs font-medium leading-4 text-text-secondary">
            {formatCredits(Number(data.available))}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleAddCredits}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-sm bg-[linear-gradient(var(--credit-cta-gradient-from),var(--credit-cta-gradient-to))] px-4 text-xs font-medium text-credit-cta-fg"
      >
        <IconCreditCard size={14} />
        Add Credits
      </button>
    </div>
  );
}

export function Sidebar({ forceExpanded = false }: { forceExpanded?: boolean } = {}) {
  const router = useRouter();
  const params = useParams<{ chatId?: string }>();
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const storeCollapsed = useUiStore((s) => s.sidebarCollapsed);
  // Mobile drawer renders at a fixed width regardless of the desktop-only
  // collapsed preference — a desktop-collapsed state must not leak into it
  // (audit finding #9).
  const collapsed = forceExpanded ? false : storeCollapsed;
  const toggleCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const { theme, setTheme } = useTheme();
  const { isSignedIn } = useAuth();
  const { openSignIn } = useClerk();

  const [searchOpen, setSearchOpen] = useState(false);
  const [footerExpanded, setFooterExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatDTO | null>(null);

  // Guest browsing: chat lists are gated on sign-in — no 401 fetch attempts
  // for a signed-out visitor, list just reflects "no data" until sign-in.
  const pinnedList = useChatsList({ pinned: true }, { enabled: Boolean(isSignedIn) });
  const mainList = useChatsList({}, { enabled: Boolean(isSignedIn) });

  const deleteChat = useDeleteChat();
  const setPinned = useSetChatPinned();
  const renameChat = useRenameChat();

  const pinnedChats = useMemo(() => pinnedList.data?.pages.flatMap((p) => p.items) ?? [], [pinnedList.data]);
  const pinnedIds = useMemo(() => new Set(pinnedChats.map((c) => c.id)), [pinnedChats]);

  const mainChats = mainList.data?.pages.flatMap((p) => p.items) ?? [];
  const recentChats = mainChats.filter((c) => !pinnedIds.has(c.id));

  // Lazy creation (S8 Chat Management): "New task" must not persist a chat
  // row until the first message is sent — that happens in EmptyState's
  // handleFirstMessage. Here we only navigate to the composer-only route.
  function handleNewChat() {
    closeSidebar();
    router.push("/");
  }

  // Library/Tasks are real pages (not popups) — guests get the sign-in
  // modal instead of navigating, same gate as attaching a file.
  function handleNavGuarded(href: string) {
    if (!isSignedIn) {
      openSignIn();
      return;
    }
    closeSidebar();
    router.push(href);
  }

  // Global shortcuts: Ctrl/Cmd+K (search), Ctrl/Cmd+B (collapse), and
  // Ctrl/Cmd+Shift+O (new task) — modifier combos, so they're safe to
  // preventDefault() globally without breaking plain-character typing in
  // the composer/search input.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (key === "b") {
        e.preventDefault();
        toggleCollapsed();
      } else if (e.shiftKey && key === "o") {
        e.preventDefault();
        handleNewChat();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleCollapsed]);

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

  return (
    <div
      // Collapse is an instant width swap, not animated — measured, S-fidelity-ui.md §2.4.
      className={cn(
        // Rounded floating card, not a flush bordered panel — the reference
        // has zero border-width here (live-measured); the boundary reads
        // purely from the --sidebar/#fafafa vs. page-background contrast.
        "flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] bg-sidebar text-sidebar-foreground",
        collapsed ? "w-[var(--layout-sidebar-rail-width)]" : "w-[var(--layout-sidebar-width)]",
      )}
    >
      {/* Horizontal inset matches the chat-row inset below (8px, ScrollArea's
          px-2) — shared 224px row width in the 240px sidebar, S-fidelity-ui.md
          §2.4 / audit finding #9. */}
      <div className="flex flex-col gap-3 px-2 py-3">
        <div className={cn("flex items-center justify-between gap-2", collapsed && "flex-col")}>
          {collapsed ? (
            // Collapsed rail: the logo mark doubles as the sidebar-expand
            // control — hovering swaps it to the toggle icon, and the
            // separate always-visible toggle button that used to sit here
            // is removed (that duplication was the complaint). The expanded
            // header below keeps its own explicit toggle button unchanged.
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-label="Expand sidebar"
                    className="group/logo relative flex size-7 items-center justify-center"
                  >
                    <span className="opacity-100 transition-opacity group-hover/logo:opacity-0">
                      <LogoMark size={12} />
                    </span>
                    <IconLayoutSidebar
                      size={16}
                      className="absolute opacity-0 transition-opacity group-hover/logo:opacity-100"
                    />
                  </button>
                }
              />
              <TooltipContent>
                Toggle sidebar <span className="ml-1.5 opacity-70">{SHORTCUT_HINT_TOGGLE_SIDEBAR}</span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Link href="/" className="cursor-pointer">
              <LogoWordmark />
            </Link>
          )}
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            {!collapsed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="Search chats"
                      onClick={() => setSearchOpen(true)}
                    >
                      <IconSearch size={16} />
                    </Button>
                  }
                />
                <TooltipContent>
                  Search <span className="ml-1.5 opacity-70">{SHORTCUT_HINT_SEARCH}</span>
                </TooltipContent>
              </Tooltip>
            )}
            {!collapsed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="Collapse sidebar"
                      onClick={toggleCollapsed}
                    >
                      <IconLayoutSidebar size={16} />
                    </Button>
                  }
                />
                <TooltipContent>
                  Toggle sidebar <span className="ml-1.5 opacity-70">{SHORTCUT_HINT_TOGGLE_SIDEBAR}</span>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {collapsed ? (
          // Collapsed rail keeps icon-only equivalents of search/new-task
          // rather than going empty — audit finding #10.
          <div className="flex flex-col items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Search chats"
                    onClick={() => setSearchOpen(true)}
                  >
                    <IconSearch size={16} />
                  </Button>
                }
              />
              <TooltipContent>
                Search <span className="ml-1.5 opacity-70">{SHORTCUT_HINT_SEARCH}</span>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon" className="size-7" aria-label="New task" onClick={handleNewChat}>
                    <IconCirclePlus size={16} />
                  </Button>
                }
              />
              <TooltipContent>New task</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Tasks"
                    onClick={() => handleNavGuarded("/tasks")}
                  >
                    <IconMessage size={16} />
                  </Button>
                }
              />
              <TooltipContent>Tasks</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Library"
                    onClick={() => handleNavGuarded("/library")}
                  >
                    <IconBooks size={16} />
                  </Button>
                }
              />
              <TooltipContent>Library</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="API / MCP"
                    render={<a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer" />}
                  >
                    <IconApiBook size={16} />
                  </Button>
                }
              />
              <TooltipContent>API / MCP</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="API Keys"
                    onClick={() => handleNavGuarded("/settings/api-keys")}
                  >
                    <IconKey size={16} />
                  </Button>
                }
              />
              <TooltipContent>API Keys</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <>
            <button
              onClick={handleNewChat}
              // Reference renders this as a plain nav row, not a filled button — same geometry as chat-list-item.tsx.
              className="group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-2 rounded-sm px-2 text-sm font-medium text-text-secondary hover:bg-accent disabled:opacity-50"
            >
              <IconCirclePlus size={16} />
              {/* Reference label is "New task"; we keep our own chat-creation semantics under that label. */}
              New task
              {/* Hover-only hint, matching reference live DOM (opacity-0 / group-hover:opacity-100). */}
              <span className="ml-auto text-xs text-text-secondary opacity-0 transition-opacity group-hover:opacity-100">
                {SHORTCUT_HINT_NEW_TASK}
              </span>
            </button>
            {/* Real pages, not popups (reference: /chat/recent and /library) — matches
                the "New task" row's own plain-nav-row geometry. */}
            <button
              onClick={() => handleNavGuarded("/tasks")}
              className="group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-2 rounded-sm px-2 text-sm font-medium text-text-secondary hover:bg-accent disabled:opacity-50"
            >
              <IconMessage size={16} />
              Tasks
            </button>
            <button
              onClick={() => handleNavGuarded("/library")}
              className="group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-2 rounded-sm px-2 text-sm font-medium text-text-secondary hover:bg-accent disabled:opacity-50"
            >
              <IconBooks size={16} />
              Library
            </button>
            {/* External docs link — unauthenticated, opens in a new tab, so it's a
                plain anchor rather than the internal handleNavGuarded(...) pattern
                the two rows above use. */}
            <a
              href={API_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-2 rounded-sm px-2 text-sm font-medium text-text-secondary hover:bg-accent disabled:opacity-50"
            >
              <IconApiBook size={16} />
              API / MCP
            </a>
            {/* Internal nav row — same handleNavGuarded pattern as Tasks/Library — to
                this app's own key-management page (Clerk's <APIKeys /> mounted at
                /settings/api-keys), distinct from the external docs link above. */}
            <button
              onClick={() => handleNavGuarded("/settings/api-keys")}
              className="group flex h-[var(--layout-sidebar-row-height)] w-full items-center gap-2 rounded-sm px-2 text-sm font-medium text-text-secondary hover:bg-accent disabled:opacity-50"
            >
              <IconKey size={16} />
              API Keys
            </button>
          </>
        )}
      </div>

      {!collapsed && (
        <ScrollArea className="min-h-0 flex-1 px-2">
          {pinnedChats.length > 0 && (
            <ChatListSection
              title="Pinned tasks"
              chats={pinnedChats}
              loading={pinnedList.isLoading}
              activeId={params.chatId}
              collapsible
              labelTone="primary"
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
        </ScrollArea>
      )}

      {/* Collapsed rail carries no account/theme controls at all (live-measured
          reference: the 48px rail's only children are the toggle, search, and
          new-task icons) — a prior fix here had added an avatar-only UserButton
          and theme toggle, which the reference does not have. */}
      {!collapsed && (
        <div className="flex shrink-0 flex-col gap-1 border-t border-border-secondary p-2">
          {/* Less/More expand toggle — collapsed density shows only the
              trigger + account row; expanded reveals the theme toggle
              (Settings omitted: no real settings surface exists in this
              app yet — see report). No credits/team content per scope. */}
          <button
            type="button"
            onClick={() => setFooterExpanded((v) => !v)}
            className="flex h-7 w-fit items-center gap-1 self-start rounded-sm px-1.5 text-xs text-text-secondary hover:bg-accent"
          >
            <IconDotsVertical size={14} />
            {footerExpanded ? "Less" : "More"}
          </button>

          {footerExpanded && (
            // Segmented pill: fully-rounded track, active segment raised as a
            // bordered white pill — not a flat ghost-button strip (audit
            // finding #12).
            <div className="flex items-center gap-0.5 rounded-pill border border-border-secondary bg-transparent p-0.5">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "flex h-7 flex-1 items-center justify-center rounded-pill text-text-secondary",
                    theme === value && "border border-border-secondary bg-background text-text-primary",
                  )}
                  aria-label={`${label} theme`}
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          )}

          {/* S7: the user has since asked for a sidebar-footer credit block
              matching the reference, reversing the earlier "No credits/team
              content per scope" decision below (and at the old comment on
              the account row) — that prior decision no longer holds.
              Gated on `footerExpanded` (not just `isSignedIn`) to match the
              reference's collapsed "More" state, which shows no credit
              content at all — fixes a real bug where this previously
              rendered regardless of expand state. Layout/values live-measured
              against the reference (see SidebarCreditBlock's own comment). */}
          {isSignedIn && footerExpanded && <SidebarCreditBlock />}

          {isSignedIn ? (
            // Real Clerk account row — avatar + full name, opens Clerk's own
            // "Manage account"/"Sign out" menu. No fabricated team content
            // (scope decision) — credits are now shown above (S7 reversal).
            <UserButton
              showName
              appearance={{
                elements: {
                  // `!important` throughout this element: Clerk's own
                  // internal styles (a `cl-internal-*` class) win the
                  // specificity battle against plain Tailwind utilities —
                  // verified live, every one of these computed back to
                  // Clerk's own default (content-sized width, row
                  // direction, flex-start justify) without it.
                  rootBox: "!w-full",
                  userButtonTrigger: "!flex !w-full items-center gap-2 rounded-sm border border-border-secondary px-2 py-1.5 hover:bg-accent focus:shadow-none",
                  // Reference layout: avatar on the left, name on the right,
                  // spread apart — Clerk's DOM order is identifier-then-
                  // avatar, so reverse the row rather than reordering the
                  // DOM.
                  userButtonBox: "!w-full min-w-0 !flex-row-reverse !justify-between gap-2",
                  // Right-aligned within its own (flex-1) box, not just
                  // pushed right by justify-between on the parent — the
                  // identifier span itself spans the row's remaining width
                  // (needed so `truncate` has room to engage on a long
                  // name), so a short name must be right-aligned inside it
                  // to actually sit at the row's right extreme rather than
                  // hugging the avatar on the left.
                  userButtonOuterIdentifier: "!min-w-0 !flex-1 !truncate !text-right text-sm text-text-primary !pl-0",
                  userButtonAvatarBox: "size-5 shrink-0",
                },
              }}
            />
          ) : (
            <Button variant="outline" size="sm" className="w-full justify-center" onClick={() => openSignIn()}>
              Sign in
            </Button>
          )}
        </div>
      )}

      <DeleteChatDialog chat={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={handleConfirmDelete} />
      <CommandSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
