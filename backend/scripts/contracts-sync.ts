/**
 * pnpm contracts:sync <path-to-frontend-repo>
 *
 * Copies backend/src/contracts/** into <frontend>/src/contracts/**,
 * stamping each file with a GENERATED header and writing
 * <frontend>/src/contracts/contracts.lock.json = { sourceSha, files }.
 * `files[path]` is the sha256 of the *original backend source content*
 * (pre-stamp) — contracts:check re-hashes both the synced copy (to catch
 * hand-edits) and, when it can see this backend checkout, the backend
 * source itself (to catch un-synced drift). See 00-master-spec.md §2.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const BACKEND_CONTRACTS_DIR = join(process.cwd(), "src", "contracts");

function listContractFiles(dir: string, base = dir): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listContractFiles(full, base));
    } else if (entry.endsWith(".ts")) {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() }).toString().trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const frontendPath = process.argv[2];
  if (!frontendPath) {
    console.error("Usage: pnpm contracts:sync <path-to-frontend-repo>");
    process.exit(1);
  }

  const sourceSha = gitSha();
  // path.join does not special-case an absolute second argument (only
  // path.resolve does) — join(cwd, "/abs/path") concatenates them into a
  // bogus nested path instead of using "/abs/path" as-is.
  const frontendRoot = isAbsolute(frontendPath) ? frontendPath : join(process.cwd(), frontendPath);
  const targetContractsDir = join(frontendRoot, "src", "contracts");
  mkdirSync(targetContractsDir, { recursive: true });

  const relFiles = listContractFiles(BACKEND_CONTRACTS_DIR);
  const files: Record<string, string> = {};

  for (const relPath of relFiles) {
    const sourcePath = join(BACKEND_CONTRACTS_DIR, relPath);
    const sourceContent = readFileSync(sourcePath, "utf8");
    const hash = sha256(sourceContent);
    files[relPath] = hash;

    const header = `// GENERATED — do not edit. Source: ${sourceSha}:src/contracts/${relPath}\n`;
    const targetPath = join(targetContractsDir, relPath);
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, header + sourceContent, "utf8");
  }

  const lock = { sourceSha, files };
  writeFileSync(join(targetContractsDir, "contracts.lock.json"), JSON.stringify(lock, null, 2) + "\n", "utf8");

  console.log(`Synced ${relFiles.length} contract file(s) to ${targetContractsDir} (source ${sourceSha}).`);
}

main();
