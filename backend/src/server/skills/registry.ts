/**
 * Skill registry: discovery/validation of `agent-skills/` directories into an in-process cache.
 * Same shape family as `server/tools/registry.ts` (O(1) lookup, lazily built), but the build
 * trigger differs — this is a lazy singleton computed on first use (not a static array), since
 * skills are discovered from disk rather than declared in code. See
 * `.claude/specs/S5-skills.md` §B "Registry discovery/validation".
 *
 * Fail loud: any malformed/invalid skill directory throws and rejects the WHOLE registry build.
 * A broken skill bundle must never silently vanish from the agent's available set.
 */
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import matter from "gray-matter";
import { getApprovedSkillsRoot } from "@/server/skills/fs-boundary";
import { SkillFrontmatterSchema } from "@/contracts/skills";

const SKILL_FILE_NAME = "SKILL.md";
/** SKILL.md is guidance text, not a data payload — bounded well below the 256KB asset cap. */
const MAX_SKILL_MD_SIZE_BYTES = 32 * 1024;

/** Internal registry record. `dirPath` and `bodyRaw` must never reach a prompt directly. */
export interface SkillEntry {
  name: string;
  description: string;
  /** Realpath'd skill directory — compatible with `resolveSkillAssetPath`'s first argument. */
  dirPath: string;
  /** SKILL.md content with YAML frontmatter stripped (the guidance body only). */
  bodyRaw: string;
  /** sha256 hex digest of the raw UTF-8 bytes of `bodyRaw`. */
  contentHash: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
}

let cachedRegistry: Promise<Map<string, SkillEntry>> | undefined;

/**
 * Lazy singleton: builds the registry on first call, caches the (in-flight or resolved) promise
 * so repeated calls never rescan the filesystem. A failed build is NOT cached — the next call
 * retries a fresh scan, since a persistent bad-state cache would make the failure unrecoverable
 * within a running process.
 */
export function getSkillRegistry(): Promise<Map<string, SkillEntry>> {
  if (!cachedRegistry) {
    cachedRegistry = buildSkillRegistry().catch((err: unknown) => {
      cachedRegistry = undefined;
      throw err;
    });
  }
  return cachedRegistry;
}

/** Test-only: clears the cached registry so it can be rebuilt against fixture directories. */
export function __resetSkillRegistryCacheForTests(): void {
  cachedRegistry = undefined;
}

/**
 * The only thing that should ever reach a prompt — `{name, description}` pairs, sorted stable
 * by name. Never leaks `dirPath`/`bodyRaw`.
 */
export async function listSkillMetadata(): Promise<SkillMetadata[]> {
  const registry = await getSkillRegistry();
  return Array.from(registry.values())
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** O(1) lookup of a skill's full record by name, for the `load_skill`/`read_skill_asset` handlers. */
export async function getSkillEntry(name: string): Promise<SkillEntry | undefined> {
  const registry = await getSkillRegistry();
  return registry.get(name);
}

async function buildSkillRegistry(): Promise<Map<string, SkillEntry>> {
  const root = await getApprovedSkillsRoot();
  const dirents = await fs.readdir(root, { withFileTypes: true });
  const skillDirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);

  const registry = new Map<string, SkillEntry>();

  for (const dirName of skillDirNames) {
    const dirPath = await fs.realpath(path.join(root, dirName));
    const skillMdPath = path.join(dirPath, SKILL_FILE_NAME);

    let stat;
    try {
      stat = await fs.stat(skillMdPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Distinguish "directory vanished mid-build" (race — exclude it, per §F) from
        // "directory exists but SKILL.md is simply missing" (a broken bundle — fail loud).
        const dirStillExists = await fs
          .stat(dirPath)
          .then(() => true)
          .catch(() => false);
        if (!dirStillExists) {
          continue;
        }
      }
      throw new Error(`Skill "${dirName}": missing mandatory ${SKILL_FILE_NAME}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Skill "${dirName}": ${SKILL_FILE_NAME} is not a regular file`);
    }
    // Stat before read: reject oversized files before any content is loaded into memory.
    if (stat.size > MAX_SKILL_MD_SIZE_BYTES) {
      throw new Error(
        `Skill "${dirName}": ${SKILL_FILE_NAME} exceeds the ${MAX_SKILL_MD_SIZE_BYTES}-byte cap (${stat.size} bytes)`,
      );
    }

    const raw = await fs.readFile(skillMdPath, "utf8");

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (err) {
      throw new Error(
        `Skill "${dirName}": malformed YAML frontmatter in ${SKILL_FILE_NAME} — ${(err as Error).message}`,
      );
    }

    const frontmatterResult = SkillFrontmatterSchema.safeParse(parsed.data);
    if (!frontmatterResult.success) {
      throw new Error(
        `Skill "${dirName}": invalid frontmatter — ${frontmatterResult.error.message}`,
      );
    }
    const frontmatter = frontmatterResult.data;

    // Additional check beyond the Zod schema: directory name must match frontmatter `name`
    // exactly, so a directory rename/content mismatch can never silently change what the agent
    // thinks it's loading.
    if (frontmatter.name !== dirName) {
      throw new Error(
        `Skill directory "${dirName}": frontmatter name "${frontmatter.name}" does not match directory name`,
      );
    }

    if (registry.has(frontmatter.name)) {
      throw new Error(`Duplicate skill name "${frontmatter.name}" found in directory "${dirName}"`);
    }

    const bodyRaw = parsed.content.trim();
    const contentHash = crypto.createHash("sha256").update(bodyRaw, "utf8").digest("hex");

    registry.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      dirPath,
      bodyRaw,
      contentHash,
    });
  }

  return registry;
}
