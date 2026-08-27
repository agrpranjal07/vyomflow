/**
 * pnpm openapi:check — wired into `prebuild`, mirrors contracts-check.ts's
 * pattern (frontend/scripts/contracts-check.ts) for the OpenAPI spec:
 * regenerate to a temp path and diff against the committed
 * `docs/openapi.json` so a stale spec fails the build instead of silently
 * drifting from the registry it's supposed to describe.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOpenApiDocument } from "@/public-api/openapi/registry";

function main() {
  const committedPath = join(process.cwd(), "..", "docs", "openapi.json");
  const fresh = JSON.stringify(generateOpenApiDocument(), null, 2) + "\n";

  let committed: string;
  try {
    committed = readFileSync(committedPath, "utf8");
  } catch {
    console.error(`openapi:check failed — missing ${committedPath}. Run \`pnpm docs:openapi\` and commit it.`);
    process.exit(1);
  }

  if (committed !== fresh) {
    const tmpDir = mkdtempSync(join(tmpdir(), "openapi-check-"));
    const tmpPath = join(tmpDir, "openapi.json");
    writeFileSync(tmpPath, fresh, "utf8");
    console.error(
      "openapi:check failed — docs/openapi.json is stale (does not match a fresh " +
        "`generateOpenApiDocument()` run).\n" +
        `  committed: ${committedPath}\n` +
        `  freshly generated (for diffing): ${tmpPath}\n` +
        "Run `pnpm docs:openapi` and commit the result.",
    );
    process.exit(1);
  }

  console.log("openapi:check passed — docs/openapi.json matches the registry.");
}

main();
