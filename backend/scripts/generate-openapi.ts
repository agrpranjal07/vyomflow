/**
 * Generates `docs/openapi.json` (at the workspace root) from
 * `src/public-api/openapi/registry.ts`, which wraps the existing internal
 * `src/contracts/**` Zod schemas. No separate public-only endpoints, no
 * hand-maintained duplicate schema.
 *
 * Run: `pnpm docs:openapi`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateOpenApiDocument } from "@/public-api/openapi/registry";

function main() {
  const document = generateOpenApiDocument();

  const outDir = join(process.cwd(), "..", "docs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "openapi.json");
  writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath} (${Object.keys(document.paths ?? {}).length} paths)`);
}

main();
