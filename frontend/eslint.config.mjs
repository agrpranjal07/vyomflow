import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use the typed client in src/lib/api-client.ts instead of raw fetch." },
      ],
    },
  },
  {
    // The only file allowed to call the platform fetch directly.
    files: ["src/lib/api-client.ts"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Private, gitignored Claude orchestration state (git-privacy-policy.md) —
    // never part of the shipped app, including any local worktree checkouts
    // it creates.
    ".claude/**",
  ]),
]);

export default eslintConfig;
