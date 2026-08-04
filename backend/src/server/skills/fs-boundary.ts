/**
 * Shared filesystem security boundary for skill asset reads.
 *
 * Used by `load_skill` / `read_skill_asset` tool handlers (built separately) to safely
 * resolve a caller-supplied relative path against a single skill's own directory, without
 * allowing traversal, symlink escape, or cross-skill reads. See
 * `.claude/specs/S5-skills.md` §B "Filesystem boundary/security model" and §F.
 */
import { promises as fs } from "fs";
import path from "path";

/** Allow-listed asset extensions — no binaries, no arbitrary file types. */
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json"]);

/** Max bytes readable for a single asset (or SKILL.md), enforced via stat before read. */
export const MAX_ASSET_SIZE_BYTES = 256 * 1024;

export type AssetRejectionReason =
  | "invalid_asset_path"
  | "unsupported_asset_type"
  | "asset_too_large"
  | "asset_not_found";

export interface AssetRejection {
  ok: false;
  reason: AssetRejectionReason;
}

export interface AssetAccepted {
  ok: true;
  /** Validated, realpath'd absolute path safe to read. */
  realPath: string;
}

export type AssetResolution = AssetAccepted | AssetRejection;

let cachedApprovedRoot: Promise<string> | undefined;

/**
 * Resolves and realpath's the single approved skills root (`backend/agent-skills/`), once
 * per process, and caches the result. Shared with the skill registry (built separately) so
 * both use the exact same canonical root.
 */
export function getApprovedSkillsRoot(): Promise<string> {
  if (!cachedApprovedRoot) {
    const resolved = path.resolve(process.cwd(), "agent-skills");
    cachedApprovedRoot = fs.realpath(resolved);
  }
  return cachedApprovedRoot;
}

/** Test-only: clears the cached approved root so it can be recomputed against a fixture cwd. */
export function __resetApprovedSkillsRootCacheForTests(): void {
  cachedApprovedRoot = undefined;
}

function isAbsoluteLike(assetPath: string): boolean {
  // POSIX absolute, or Windows-style absolute (drive letter or UNC).
  return path.isAbsolute(assetPath) || /^[a-zA-Z]:[\\/]/.test(assetPath) || assetPath.startsWith("\\\\");
}

function hasTraversalSegment(assetPath: string): boolean {
  const normalized = path.normalize(assetPath);
  return normalized.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * Single entry point: given a skill's own real directory path and a caller-supplied relative
 * asset path, validates and resolves it, or returns a typed rejection reason.
 *
 * `skillRealDirPath` must already be the realpath'd directory for the specific skill (never
 * the shared root) — this is what prevents one skill's assets from being reachable via another
 * skill's tool call, even by name-guessing.
 */
export async function resolveSkillAssetPath(
  skillRealDirPath: string,
  assetPath: string,
): Promise<AssetResolution> {
  // 1. Reject absolute paths before any filesystem call (cheap, avoids TOCTOU on reject path).
  if (isAbsoluteLike(assetPath)) {
    return { ok: false, reason: "invalid_asset_path" };
  }

  // 2. Reject traversal segments after normalization.
  if (hasTraversalSegment(assetPath)) {
    return { ok: false, reason: "invalid_asset_path" };
  }

  // 3. Join against the skill's OWN directory — never the shared root.
  const joined = path.join(skillRealDirPath, assetPath);

  // 4. Realpath and verify containment (defeats symlink escape even absent literal "..").
  let realPath: string;
  try {
    realPath = await fs.realpath(joined);
  } catch {
    return { ok: false, reason: "asset_not_found" };
  }
  const boundary = skillRealDirPath.endsWith(path.sep) ? skillRealDirPath : skillRealDirPath + path.sep;
  if (!realPath.startsWith(boundary)) {
    return { ok: false, reason: "invalid_asset_path" };
  }

  // 5. Extension allow-list.
  const ext = path.extname(realPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "unsupported_asset_type" };
  }

  // 6. Stat before read: reject missing/non-regular files, and oversized files, before any
  // file content is loaded into memory.
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return { ok: false, reason: "asset_not_found" };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "asset_not_found" };
  }
  if (stat.size > MAX_ASSET_SIZE_BYTES) {
    return { ok: false, reason: "asset_too_large" };
  }

  return { ok: true, realPath };
}
