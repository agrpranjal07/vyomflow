import { vi } from "vitest";
import type { ReactNode } from "react";

/**
 * Global stand-in for "@clerk/nextjs" in the frontend RTL suite (see the
 * "@clerk/nextjs" alias in vitest.frontend.config.mts — same rationale as
 * the react/react-dom/lucide-react/@tanstack/react-query aliases there:
 * @clerk/nextjs is only installed in frontend/node_modules, so a component
 * test's own vi.mock("@clerk/nextjs") resolves a different module identity
 * than the one frontend/src actually imports and never intercepts it).
 * Component tests render outside a real <ClerkProvider>; every export here
 * is the minimal stub the currently-tested components (attach-button,
 * empty-state, app-header, sidebar) call.
 */
export function useAuth() {
  return { isSignedIn: true, getToken: async () => "test-token" };
}

// Stable module-level fns (not fresh vi.fn()s per render) so a test can
// `import { clerkSignOut } from "@clerk/nextjs"` — same pattern as
// mocks/sonner.tsx's `toast` — and assert on calls directly.
export const clerkSignOut = vi.fn();
const clerkOpenSignIn = vi.fn();

export function useClerk() {
  return { openSignIn: clerkOpenSignIn, signOut: clerkSignOut };
}

export function UserButton() {
  return null;
}

export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}
