"use client";

import { Sidebar } from "@/components/chat/sidebar";
import { MobileSidebarDrawer } from "@/components/chat/mobile-sidebar-drawer";
import { AppHeader } from "@/components/chat/app-header";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    // Reference is a floating-card layout, not a flush panel: the whole
    // shell carries 8px padding/gap so the sidebar and main pane read as two
    // separate rounded cards inset from the viewport edge (live DOM measurement,
    // .claude/evidence/sidebar.md).
    <div className="flex h-dvh w-full gap-2 overflow-hidden p-2">
      <aside
        className={cn(
          "hidden shrink-0 md:block",
          sidebarCollapsed ? "w-[var(--layout-sidebar-rail-width)]" : "w-[var(--layout-sidebar-width)]",
        )}
      >
        <Sidebar />
      </aside>

      <MobileSidebarDrawer open={sidebarOpen} onClose={closeSidebar} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] bg-background">
        <AppHeader />
        {children}
      </div>
    </div>
  );
}
