import { vi } from "vitest";

/**
 * Global stand-in for "sonner" in the frontend RTL suite (see the "sonner"
 * alias in vitest.frontend.config.mts — same rationale as the
 * @clerk/nextjs/@trigger.dev/react-hooks aliases there: sonner is only
 * installed in frontend/node_modules, so a test's own vi.mock("sonner")
 * resolves a different module identity than the one frontend/src actually
 * imports and never intercepts it). Individual tests read call args off
 * these vi.fn()s directly (e.g. `import { toast } from "sonner"`).
 */
export const toast = {
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
};

export function Toaster() {
  return null;
}
