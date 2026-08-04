/**
 * S5: buildSystemPromptContent() composes AGENT_SYSTEM_PROMPT + the validated skill roster
 * (name/description only) fresh every call. Uses the same real-fixtures-via-chdir technique as
 * skills-registry.test.ts to point the registry at either the real checked-in `agent-skills/` or
 * a synthetic temp root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { AGENT_SYSTEM_PROMPT, buildSystemPromptContent } from "@/server/agent/system-prompt";
import { __resetSkillRegistryCacheForTests } from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";

const REAL_BACKEND_DIR = path.resolve(__dirname, "../../backend");

async function writeSkill(root: string, dirName: string, frontmatter: string, body: string): Promise<void> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

describe("buildSystemPromptContent (S5)", () => {
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

  async function useFixtureRoot(): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "system-prompt-skills-"));
    tmpRoot = path.join(parent, "agent-skills");
    await fs.mkdir(tmpRoot, { recursive: true });
    process.chdir(parent);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
    return tmpRoot;
  }

  it("includes each real fixture skill's name+description, base prompt, but no body text", async () => {
    process.chdir(REAL_BACKEND_DIR);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();

    const content = await buildSystemPromptContent();

    // Additive, not a replacement.
    expect(content).toContain(AGENT_SYSTEM_PROMPT);

    // Real fixture names/descriptions present.
    expect(content).toContain("crop-image-guidance");
    expect(content).toContain(
      "Load before calling crop_image to choose the right coordinate format (percent, exact pixels, or a crop object) and avoid partial/out-of-bounds rectangles.",
    );
    expect(content).toContain("generate-image-guidance");
    expect(content).toContain("merge-videos-guidance");

    // Distinctive body-only sentences must NOT leak into the composed prompt.
    expect(content).not.toContain("Prefer the `crop.{x,y,width,height}` object form");
    expect(content).not.toContain("Choose the transition option based on the desired feel between clips");
  });

  it("synthetic fixtures: composed prompt contains name/description, not body", async () => {
    const root = await useFixtureRoot();
    await writeSkill(
      root,
      "alpha-skill",
      "name: alpha-skill\ndescription: Alpha description text",
      "A very distinctive alpha body sentence that must never leak.",
    );
    await writeSkill(
      root,
      "zeta-skill",
      "name: zeta-skill\ndescription: Zeta description text",
      "A very distinctive zeta body sentence that must never leak.",
    );

    const content = await buildSystemPromptContent();

    expect(content).toContain(AGENT_SYSTEM_PROMPT);
    expect(content).toContain("alpha-skill");
    expect(content).toContain("Alpha description text");
    expect(content).toContain("zeta-skill");
    expect(content).toContain("Zeta description text");
    expect(content).not.toContain("very distinctive alpha body sentence");
    expect(content).not.toContain("very distinctive zeta body sentence");
  });

  it("no skills present: composed prompt equals the base prompt (no dangling section)", async () => {
    await useFixtureRoot();

    const content = await buildSystemPromptContent();

    expect(content).toBe(AGENT_SYSTEM_PROMPT);
  });

  // T18 (S7 plan §9.4): at 100 skills, the composed prompt must carry
  // exactly 100 name+description pairs and ZERO skill bodies, and stay
  // under a justified size threshold.
  it("scales to ~100 skills: exactly 100 name+description pairs, zero bodies, bounded size, completes quickly", async () => {
    const root = await useFixtureRoot();
    const count = 100;
    for (let i = 0; i < count; i++) {
      const name = `skill-${String(i).padStart(3, "0")}`;
      await writeSkill(
        root,
        name,
        `name: ${name}\ndescription: Guidance for ${name}`,
        // A distinctive body sentence per skill — must never leak into the prompt.
        `BODY_ONLY_SENTINEL_${i} — full guidance content for ${name} that only load_skill should ever return.`,
      );
    }

    const start = Date.now();
    const content = await buildSystemPromptContent();
    const elapsedMs = Date.now() - start;

    expect(content).toContain(AGENT_SYSTEM_PROMPT);

    // Exactly 100 name+description pairs — one "- skill-NNN: Guidance for
    // skill-NNN" line per registered skill, no more, no fewer.
    for (let i = 0; i < count; i++) {
      const name = `skill-${String(i).padStart(3, "0")}`;
      expect(content).toContain(`- ${name}: Guidance for ${name}`);
    }
    const skillLineCount = (content.match(/^- skill-\d{3}: Guidance for skill-\d{3}$/gm) ?? []).length;
    expect(skillLineCount).toBe(count);

    // Zero skill bodies present — every per-skill sentinel sentence must be absent.
    for (let i = 0; i < count; i++) {
      expect(content).not.toContain(`BODY_ONLY_SENTINEL_${i}`);
    }

    // Threshold rationale: 100 skills * (~10 char name + ~20 char
    // description + ~5 chars of "- " / ": " / newline formatting) is
    // roughly 100 * 35 = 3,500 chars, plus the fixed ~900-char
    // AGENT_SYSTEM_PROMPT and section header. 50,000 is a ~10x safety
    // margin over that estimate — generous enough to tolerate real
    // skills with longer descriptions than this synthetic fixture, while
    // still catching an actual body-leak regression (a single leaked body
    // would blow well past this bound, since SKILL.md bodies can run up
    // to the registry's own 32KB-per-file cap).
    expect(content.length).toBeLessThan(50_000);
    expect(elapsedMs).toBeLessThan(5000);
  }, 10000);
});
