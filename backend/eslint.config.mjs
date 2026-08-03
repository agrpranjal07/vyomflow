import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    // Trigger.dev local dev build artifacts (`npx trigger.dev dev`) —
    // bundled/minified .mjs chunks, not source we own.
    ".trigger/**",
    // Private, gitignored Claude orchestration state (git-privacy-policy.md) —
    // never part of the shipped app, including any local worktree checkouts
    // it creates.
    ".claude/**",
  ]),
]);

export default eslintConfig;
