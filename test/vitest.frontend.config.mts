import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

const here = dirname(fileURLToPath(import.meta.url));
const localModules = join(here, "node_modules");

// Frontend component + service-layer tests (RTL, MSW). jsdom environment;
// resolves the frontend's own "@/..." alias into ../frontend/src, same
// alias-replication approach as the backend integration config.
//
// React duplication: components under frontend/src resolve "react" from
// frontend/node_modules (nearest-node_modules walk from their own file
// path) while @testing-library/react — installed in this workspace —
// would otherwise resolve a second, separate React copy. Two React
// instances in one render tree breaks hooks ("Invalid hook call").
// react/react-dom are installed directly in this workspace too, and every
// "react"/"react-dom" import (regardless of which file requests it) is
// aliased to that single local copy — the same one @testing-library/react
// renders with. lucide-react gets the same treatment for a different
// reason: its shipped dist/cjs bundle has its own require("react") baked
// in at build time, which is a raw Node CJS require, not an ESM import
// specifier Vite's resolver ever sees — no alias/dedupe/inline on react
// itself can redirect it. Aliasing the whole lucide-react package to a
// copy installed in this workspace makes that internal require resolve
// within this same project tree instead of crossing into frontend's.
export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react-dom\/(.*)$/, replacement: join(localModules, "react-dom") + "/$1" },
      { find: "react-dom", replacement: join(localModules, "react-dom") },
      { find: /^react\/(.*)$/, replacement: join(localModules, "react") + "/$1" },
      { find: "react", replacement: join(localModules, "react") },
      // lucide-react's shipped dist/cjs bundle contains its own baked-in
      // require("react") call — a raw Node CJS require, not an ESM import
      // specifier Vite's resolver sees, so no alias above can redirect
      // it (confirmed: aliasing/deduping/inlining react itself did not
      // stop it from pulling frontend's copy). Aliasing the *whole
      // package* to a copy installed directly in this workspace's own
      // node_modules sidesteps the problem: that copy's require("react")
      // then naturally resolves within this same project tree, matching
      // the React instance @testing-library/react renders with.
      { find: "lucide-react", replacement: join(localModules, "lucide-react") },
      // Same reasoning as react/react-dom above: hooks under test import
      // "@tanstack/react-query" from frontend/node_modules by nearest-
      // resolution; a test's own QueryClientProvider must be the *same*
      // module instance or useQueryClient() inside the hook won't see the
      // context. Installed directly in this workspace for S2's
      // use-active-run tests.
      { find: "@tanstack/react-query", replacement: join(localModules, "@tanstack", "react-query") },
      // next/link's real implementation calls useContext for the App Router context. "next" isn't
      // installed in this workspace, so vi.mock("next/link", ...) declared from a test file can
      // never resolve/intercept it (the real module only exists in frontend/node_modules, resolved
      // relative to the importing frontend/src file) — it always loads for real, duplicating React
      // the same way react/react-dom/lucide-react/@tanstack/react-query did above, crashing with
      // "Invalid hook call" on render. A component test that renders next/link should get a plain
      // anchor instead; this alias makes that the single resolution for every "next/link" import.
      { find: "next/link", replacement: join(here, "frontend", "mocks", "next-link.tsx") },
      // Same resolution mismatch as next/link — next/image's real implementation goes through
      // Next's image optimization pipeline, meaningless in jsdom; render a plain <img> instead.
      { find: "next/image", replacement: join(here, "frontend", "mocks", "next-image.tsx") },
      // Same resolution mismatch as next/link above — sidebar.tsx's useRouter/useParams
      // (App Router context) and useTheme (next-themes' own context) both need the same
      // React instance react-dom renders with; neither package is installed in this
      // workspace, so per-test vi.mock() can't intercept them.
      { find: "next/navigation", replacement: join(here, "frontend", "mocks", "next-navigation.tsx") },
      { find: "next-themes", replacement: join(here, "frontend", "mocks", "next-themes.tsx") },
      // @clerk/nextjs is only installed in frontend/node_modules (not this
      // workspace's) — same resolution mismatch as react/react-dom above:
      // a component test's own vi.mock("@clerk/nextjs") would resolve a
      // different module identity than the one frontend/src imports and
      // never intercept it. Alias the whole package to a local stub
      // instead (components render outside a real <ClerkProvider> here).
      { find: "@clerk/nextjs", replacement: join(here, "frontend", "mocks", "clerk-nextjs.tsx") },
      // "@trigger.dev/react-hooks" is only installed in frontend/node_modules
      // (not this workspace's), and its own custom source-condition export
      // resolution separately defeats Vitest's module mocking even when that
      // isn't the issue (see run-status.test.ts's file header). Alias the
      // whole package to a controllable fake — use-active-run.test.tsx drives
      // it via the mock's own __set*/__mockReset exports.
      { find: "@trigger.dev/react-hooks", replacement: join(here, "frontend", "mocks", "trigger-react-hooks.tsx") },
      // "sonner" is only installed in frontend/node_modules (not this workspace's) —
      // same resolution mismatch as @clerk/nextjs above. Alias the whole package to a
      // controllable stub; tests import { toast } from "sonner" to read its vi.fn() calls.
      { find: "sonner", replacement: join(here, "frontend", "mocks", "sonner.tsx") },
    ],
  },
  plugins: [
    react(),
    tsconfigPaths({ projects: ["./tsconfig.frontend.json", "../frontend/tsconfig.json"] }),
  ],
  test: {
    environment: "jsdom",
    include: ["frontend/**/*.test.tsx", "frontend/**/*.test.ts"],
    setupFiles: ["frontend/setup.ts"],
    server: {
      // Packages under node_modules are normally externalized (loaded via
      // native Node require, bypassing Vite's resolver entirely) —
      // resolve.alias above would silently not apply to them, including
      // transitively (e.g. @testing-library/react's own internal
      // react-dom/client import, itself externalized, never passes
      // through Vite regardless of aliasing react-dom directly). Inlining
      // everything forces the whole chain through Vite's module graph so
      // the alias to frontend's single React copy actually takes effect
      // (Vitest docs: "alias the actual node_modules packages... to
      // support externalized dependencies" pairs with inlining them).
      // Fine for this workspace's small test surface.
      deps: { inline: true },
    },
  },
});
