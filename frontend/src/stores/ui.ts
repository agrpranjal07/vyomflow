import { create } from "zustand";

interface UiState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  /** Desktop collapse-to-rail state — distinct from the mobile drawer above. */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
}

/** Ephemeral, client-only chrome state (mobile sidebar open/closed, desktop collapse) — not server state, so TanStack Query doesn't own it. */
export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
