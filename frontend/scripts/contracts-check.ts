/**
 * pnpm contracts:check — wired into `prebuild` and CI.
 *
 * Two independent checks against src/contracts/contracts.lock.json:
 *  1. Integrity: every synced file's content (header stripped) still
 *     matches the hash recorded at sync time. Fails on a hand-edit.
 *  2. Drift: when a sibling backend checkout is visible (this workspace's
 *     layout, or CONTRACTS_BACKEND_PATH), the backend's current
 *     src/contracts/** is re-hashed and compared to the same lock entries.
 *     Fails if the backend changed without a re-sync. Skipped with a
 *     warning (not a failure) when no backend checkout is reachable, e.g.
 *     a standalone frontend-only CI job.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Lock {
  sourceSha: string;
  files: Record<string, string>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stripGeneratedHeader(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.startsWith("// GENERATED")) {
    return lines.slice(1).join("\n");
  }
  return content;
}

function main() {
  const contractsDir = join(process.cwd(), "src", "contracts");
  const lockPath = join(contractsDir, "contracts.lock.json");

  if (!existsSync(lockPath)) {
    console.error(`contracts:check failed — missing ${lockPath}. Run contracts:sync from the backend repo first.`);
    process.exit(1);
  }

  const lock: Lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const failures: string[] = [];

  // 1. Integrity — the synced copy must still match its recorded hash.
  for (const [relPath, expectedHash] of Object.entries(lock.files)) {
    const filePath = join(contractsDir, relPath);
    if (!existsSync(filePath)) {
      failures.push(`missing synced file: ${relPath}`);
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    const actualHash = sha256(stripGeneratedHeader(content));
    if (actualHash !== expectedHash) {
      failures.push(`hand-edited or corrupted synced file: ${relPath}`);
    }
  }

  // 2. Drift — only when a backend checkout is actually reachable.
  const backendPath = process.env.CONTRACTS_BACKEND_PATH ?? join(process.cwd(), "..", "backend");
  const backendContractsDir = join(backendPath, "src", "contracts");
  if (existsSync(backendContractsDir)) {
    for (const [relPath, expectedHash] of Object.entries(lock.files)) {
      const sourcePath = join(backendContractsDir, relPath);
      if (!existsSync(sourcePath)) {
        failures.push(`backend contract removed without re-sync: ${relPath}`);
        continue;
      }
      const sourceContent = readFileSync(sourcePath, "utf8");
      const actualHash = sha256(sourceContent);
      if (actualHash !== expectedHash) {
        failures.push(`backend contract changed without re-sync: ${relPath}`);
      }
    }
  } else {
    console.warn(`contracts:check — no backend checkout at ${backendPath}; skipping drift check (integrity check still ran).`);
  }

  if (failures.length > 0) {
    console.error("contracts:check failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`contracts:check passed (${Object.keys(lock.files).length} file(s), source ${lock.sourceSha}).`);
}

main();
