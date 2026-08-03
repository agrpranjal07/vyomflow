import { vi } from "vitest";

// Stand-in for next-themes, same reasoning as next-link.tsx/next-navigation.tsx:
// only installed in frontend/node_modules, so a per-test vi.mock() from this
// workspace can't intercept the real module's import inside frontend/src —
// aliased at the Vite config level instead.
export const useTheme = vi.fn(() => ({ theme: "dark", setTheme: vi.fn(), resolvedTheme: "dark" }));
