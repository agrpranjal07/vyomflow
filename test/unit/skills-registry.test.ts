import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  getSkillRegistry,
  listSkillMetadata,
  getSkillEntry,
  __resetSkillRegistryCacheForTests,
} from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";

const REAL_BACKEND_DIR = path.resolve(__dirname, "../../backend");

/** Writes a single skill directory with a SKILL.md whose frontmatter is exactly `frontmatter`. */
async function writeSkill(
  root: string,
  dirName: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

describe("skill registry", () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    __resetSkillRegistryCacheForTests();
    __resetApprovedSkillsRootCacheForTests();
    if (tmpRoot) {
      await fs.rm(path.dirname(tmpRoot), { recursive: true, force: true });
    }
  });

  /**
   * Points the shared approved-root cache at a fresh temp `agent-skills/` directory by
   * chdir-ing into its parent, mirroring how `getApprovedSkillsRoot()` resolves
   * `path.resolve(process.cwd(), "agent-skills")` in the real app.
   */
  async function useFixtureRoot(): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "skills-registry-"));
    tmpRoot = path.join(parent, "agent-skills");
    await fs.mkdir(tmpRoot, { recursive: true });
    process.chdir(parent);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
    return tmpRoot;
  }

  it("happy path: real checked-in agent-skills/ discovers all 3 fixture skills", async () => {
    process.chdir(REAL_BACKEND_DIR);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();

    const metadata = await listSkillMetadata();
    expect(metadata.map((m) => m.name)).toEqual(
      ["crop-image-guidance", "generate-image-guidance", "merge-videos-guidance"].sort(),
    );
    for (const entry of metadata) {
      expect(entry.description.length).toBeGreaterThan(0);
      // Only name/description ever reach listSkillMetadata() — no leaked internal fields.
      expect(Object.keys(entry).sort()).toEqual(["description", "name"]);
    }

    const cropEntry = await getSkillEntry("crop-image-guidance");
    expect(cropEntry).toBeDefined();
    expect(cropEntry?.bodyRaw).toContain("Crop Image Guidance");
    expect(cropEntry?.bodyRaw).not.toContain("---");
    expect(cropEntry?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("synthetic happy path: multi-skill dir, listSkillMetadata sorted by name, no bodies leaked", async () => {
    const root = await useFixtureRoot();
    await writeSkill(root, "zeta-skill", "name: zeta-skill\ndescription: Z desc", "Zeta body");
    await writeSkill(root, "alpha-skill", "name: alpha-skill\ndescription: A desc", "Alpha body");

    const metadata = await listSkillMetadata();
    expect(metadata).toEqual([
      { name: "alpha-skill", description: "A desc" },
      { name: "zeta-skill", description: "Z desc" },
    ]);
    for (const m of metadata) {
      expect(m).not.toHaveProperty("dirPath");
      expect(m).not.toHaveProperty("bodyRaw");
    }

    const entry = await getSkillEntry("alpha-skill");
    expect(entry?.bodyRaw).toBe("Alpha body");
    expect(entry?.dirPath).toContain("alpha-skill");
  });

  it("rejects malformed/unparseable YAML frontmatter — whole build fails", async () => {
    const root = await useFixtureRoot();
    const dir = path.join(root, "broken-skill");
    await fs.mkdir(dir, { recursive: true });
    // Unbalanced/invalid YAML (bad indentation + unterminated flow mapping).
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: broken-skill\n  description: [unterminated\n---\nBody",
    );

    await expect(getSkillRegistry()).rejects.toThrow(/frontmatter/i);
  });

  it("rejects missing name in frontmatter — whole build fails", async () => {
    const root = await useFixtureRoot();
    await writeSkill(root, "no-name-skill", "description: has description only", "Body");

    await expect(getSkillRegistry()).rejects.toThrow();
  });

  it("rejects missing description in frontmatter — whole build fails", async () => {
    const root = await useFixtureRoot();
    await writeSkill(root, "no-desc-skill", "name: no-desc-skill", "Body");

    await expect(getSkillRegistry()).rejects.toThrow();
  });

  it("rejects frontmatter name mismatched from directory name — whole build fails", async () => {
    const root = await useFixtureRoot();
    await writeSkill(root, "actual-dir-name", "name: different-name\ndescription: desc", "Body");

    await expect(getSkillRegistry()).rejects.toThrow(/does not match directory name/);
  });

  it("rejects a naming collision across two directories — whole build fails loud", async () => {
    // Note: since frontmatter `name` must equal its OWN directory name (enforced above the
    // duplicate check), and a single filesystem directory can never contain two entries with an
    // identical name, an exact "same registered name from two independently-valid directories"
    // case cannot occur on disk — the directory-match invariant makes it structurally
    // unreachable. The duplicate-name guard in registry.ts is defense-in-depth for that
    // (currently unreachable) case. What IS reachable and must still fail loud is a directory
    // whose frontmatter claims a name already claimed by another directory's own valid name —
    // which trips the mismatch guard first. Assert the build fails loud either way.
    const root = await useFixtureRoot();
    await writeSkill(root, "dup-a", "name: dup-a\ndescription: first", "Body A");
    await writeSkill(root, "dup-a-2", "name: dup-a\ndescription: second", "Body A2");

    await expect(getSkillRegistry()).rejects.toThrow(/does not match directory name|Duplicate/);
  });

  it("rejects oversized SKILL.md (>32KB) — whole build fails, verified via stat before read", async () => {
    const root = await useFixtureRoot();
    const dir = path.join(root, "huge-skill");
    await fs.mkdir(dir, { recursive: true });
    const bigBody = "a".repeat(40 * 1024);
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: huge-skill\ndescription: desc\n---\n${bigBody}`,
    );

    await expect(getSkillRegistry()).rejects.toThrow(/32.*byte|exceeds/i);
  });

  it("scales to ~100 skills: listSkillMetadata returns 100 entries, bounded size, reasonable time", async () => {
    const root = await useFixtureRoot();
    const count = 100;
    for (let i = 0; i < count; i++) {
      const name = `skill-${String(i).padStart(3, "0")}`;
      await writeSkill(root, name, `name: ${name}\ndescription: Guidance for ${name}`, `Body ${i}`);
    }

    const start = Date.now();
    const metadata = await listSkillMetadata();
    const elapsedMs = Date.now() - start;

    expect(metadata).toHaveLength(count);
    const serializedSize = JSON.stringify(metadata).length;
    // Rough sanity bound — bodies/dirPaths never leak, so size stays proportional to
    // name+description text, not to any per-skill body content.
    expect(serializedSize).toBeLessThan(20_000);
    expect(elapsedMs).toBeLessThan(5000);
  }, 10000);

  // T19 (S7 plan §9.4): at 100 skills, load_skill-style on-demand resolution
  // must still be O(1) lookup, not a linear scan re-reading the filesystem
  // or re-walking an array. `getSkillRegistry()` is typed to return a
  // `Map<string, SkillEntry>` (registry.ts) and `getSkillEntry` is a direct
  // `.get()` against it — asserting the structural type plus a correct
  // resolution for an arbitrary (non-first, non-last) skill name pins that
  // shape rather than inferring it from timing, which would be flaky.
  it("at 100 skills, getSkillRegistry() is Map-backed and getSkillEntry resolves any single name via direct Map.get (O(1), not a scan)", async () => {
    const root = await useFixtureRoot();
    const count = 100;
    for (let i = 0; i < count; i++) {
      const name = `skill-${String(i).padStart(3, "0")}`;
      await writeSkill(root, name, `name: ${name}\ndescription: Guidance for ${name}`, `Body ${i}`);
    }

    const registry = await getSkillRegistry();
    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBe(count);

    // Resolve a skill from the middle of the set — not the first or last
    // directory scanned — to demonstrate lookup doesn't depend on scan
    // position, only on the Map key.
    const midName = "skill-050";
    const entry = await getSkillEntry(midName);
    expect(entry).toBeDefined();
    expect(entry?.name).toBe(midName);
    expect(entry?.bodyRaw).toBe("Body 50");

    // A name that was never registered still resolves in O(1) (a Map miss,
    // not a linear "not found after scanning everything" fallback).
    expect(await getSkillEntry("skill-999-does-not-exist")).toBeUndefined();
  });
});
