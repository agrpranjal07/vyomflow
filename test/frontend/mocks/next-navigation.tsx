import { vi } from "vitest";

// Stand-in for next/navigation, same reasoning as next-link.tsx: the real
// module (only installed in frontend/node_modules) reaches for the App
// Router context via useContext, requiring the same React module instance
// react-dom renders with — a per-test vi.mock() from this workspace can't
// intercept it (resolved relative to the importing frontend/src file), so
// it must be aliased at the Vite config level instead.
export const useRouter = vi.fn(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));

export const useParams = vi.fn(() => ({}));
export const usePathname = vi.fn(() => "/");
export const useSearchParams = vi.fn(() => new URLSearchParams());
