import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const here = dirname(fileURLToPath(import.meta.url));

// Route Handler integration tests: import the backend's exported route
// Handler functions (GET/POST/DELETE) directly and invoke them with real
// Request objects, asserting on real Response objects — the Route Handler
// module itself is treated as the HTTP boundary under test (decided
// explicitly; see testing-policy.md's "Route Handler testing methodology"
// section). Real test PostgreSQL database, no live server process.
export default defineConfig({
  resolve: {
    alias: [
      // "@trigger.dev/sdk" is only installed in backend/node_modules
      // (resolved relative to the importing backend/src file, e.g.
      // src/services/runs.ts), not in this test workspace's own
      // node_modules — the same cross-workspace resolution mismatch
      // vitest.frontend.config.mts documents for "next/link". A `vi.mock`
      // declared from a test file here can't intercept it (verified: the
      // real SDK loaded and threw its own "TRIGGER_SECRET_KEY" auth error
      // instead of the mock ever running) since this file's own module
      // resolution can't find the package to register the mock against in
      // the first place. Aliasing the bare specifier to a local mock file
      // is the same fix pattern used there — every "@trigger.dev/sdk"
      // import in the whole module graph resolves to this one physical
      // file instead. Only reconcileIfStale (src/services/runs.ts) reaches
      // a real, unmocked import of this package in any route-boundary
      // integration test; every route that also touches
      // src/server/dispatch.ts's own "@trigger.dev/sdk" import mocks that
      // whole module wholesale via ../support/trigger-mock, so its real
      // body — and therefore its "@trigger.dev/sdk" import — never
      // executes.
      { find: "@trigger.dev/sdk", replacement: join(here, "support", "trigger-sdk-mock.ts") },
    ],
  },
  plugins: [
    // Explicit `projects`, not `root`-crawling: vite-tsconfig-paths scopes
    // each tsconfig's aliases to files within that tsconfig's own directory
    // tree. backend/src/lib/db.ts's own internal "@/..." imports need
    // backend/tsconfig.json's mapping applied to *it*, not this project's —
    // both must be registered for the alias-replication trick to reach
    // every file in the import graph, not just the test files directly
    // under this workspace.
    tsconfigPaths({ projects: ["./tsconfig.json", "../backend/tsconfig.json"] }),
  ],
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    setupFiles: ["integration/setup.ts"],
    // Integration specs share one Postgres connection pool and truncate
    // between tests — running them concurrently would race on shared state.
    fileParallelism: false,
  },
});
