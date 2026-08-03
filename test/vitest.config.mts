import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const here = dirname(fileURLToPath(import.meta.url));

// Fast, DB-free unit tests (contract schema validation, etc.).
export default defineConfig({
  resolve: {
    alias: [
      // "zod" is only installed in backend/node_modules (resolved relative
      // to the importing backend/src file), not in this test workspace's
      // own node_modules — same cross-workspace resolution mismatch
      // vitest.integration.config.mts documents for "@trigger.dev/sdk".
      // S7 T20/T22 build synthetic ToolDefinition fixtures directly in a
      // test file and need `z`/`z.toJSONSchema` themselves, not just
      // transitively through an imported backend module.
      { find: "zod", replacement: join(here, "..", "backend", "node_modules", "zod") },
      // Same cross-workspace mismatch as "zod" above — crop-image-adapter.test.ts
      // imports sharp directly (to build/decode fixture PNGs), and sharp is only
      // installed in backend/node_modules.
      { find: "sharp", replacement: join(here, "..", "backend", "node_modules", "sharp") },
    ],
  },
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json", "../backend/tsconfig.json"] })],
  test: {
    environment: "node",
    include: ["unit/**/*.test.ts"],
  },
});
