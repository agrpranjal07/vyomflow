import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { testDb } from "../support/db";
import { loadSkillHandler } from "@/server/skills/load-skill";
import { __resetSkillRegistryCacheForTests } from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";

// `getApprovedSkillsRoot()` resolves `agent-skills/` relative to
// `process.cwd()` — this workspace runs tests from `test/`, so the real
// checked-in skills (used for the happy-path/dedup cases) are only visible
// once chdir'd into `backend/`, mirroring `unit/skills-registry.test.ts`.
const REAL_BACKEND_DIR = path.resolve(__dirname, "../../backend");

async function makeChatAndRun() {
  const user = await testDb.user.create({ data: { clerkUserId: `user_${Math.random()}` } });
  const chat = await testDb.chat.create({ data: { ownerId: user.id, title: "t" } });
  const userMessage = await testDb.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  const run = await testDb.agentRun.create({
    data: {
      chatId: chat.id,
      idempotencyKey: `send:${chat.id}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
    },
  });
  return { user, chat, run };
}

/** Real, checked-in skills — used for the happy-path/dedup cases. */
const REAL_SKILL_NAME = "crop-image-guidance";

describe("load_skill handler — RunSkill persistence/dedup/resume", () => {
  let tmpRoot: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(REAL_BACKEND_DIR);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    __resetSkillRegistryCacheForTests();
    __resetApprovedSkillsRootCacheForTests();
    if (tmpRoot) {
      await fs.rm(path.dirname(tmpRoot), { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it("unknown skill name returns a structured unknown_skill error and writes no RunSkill row", async () => {
    const { run } = await makeChatAndRun();

    const result = await loadSkillHandler({ skillName: "does-not-exist" }, { agentRunId: run.id });

    expect(result).toEqual({ error: expect.any(String), code: "unknown_skill" });
    expect(await testDb.runSkill.count()).toBe(0);
  });

  it("valid skill, first load creates a RunSkill row with correct fields", async () => {
    const { run } = await makeChatAndRun();

    const result = await loadSkillHandler({ skillName: REAL_SKILL_NAME }, { agentRunId: run.id });

    expect(result).toMatchObject({ name: REAL_SKILL_NAME, description: expect.any(String) });
    const row = await testDb.runSkill.findUniqueOrThrow({
      where: { agentRunId_skillName: { agentRunId: run.id, skillName: REAL_SKILL_NAME } },
    });
    expect(row.agentRunId).toBe(run.id);
    expect(row.skillName).toBe(REAL_SKILL_NAME);
    expect(row.contentHash).toBe((result as { contentHash: string }).contentHash);
    expect(row.content).toBe((result as { content: string }).content);
  });

  it("repeated load in the same run dedups to one row and returns identical content", async () => {
    const { run } = await makeChatAndRun();

    const first = await loadSkillHandler({ skillName: REAL_SKILL_NAME }, { agentRunId: run.id });
    const second = await loadSkillHandler({ skillName: REAL_SKILL_NAME }, { agentRunId: run.id });

    expect(await testDb.runSkill.count()).toBe(1);
    expect(second).toEqual(first);
  });

  it("resumed run reuses the originally persisted content, not skill content changed on disk since", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "skills-load-"));
    tmpRoot = path.join(parent, "agent-skills");
    const skillDir = path.join(tmpRoot, "mutable-skill");
    await fs.mkdir(skillDir, { recursive: true });
    const skillMdPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillMdPath,
      "---\nname: mutable-skill\ndescription: test skill for mutation.\n---\nORIGINAL BODY\n",
    );
    process.chdir(parent);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();

    const { run } = await makeChatAndRun();

    const first = await loadSkillHandler({ skillName: "mutable-skill" }, { agentRunId: run.id });
    expect((first as { content: string }).content).toContain("ORIGINAL BODY");

    // Mutate the skill on disk and rebuild the registry cache, simulating
    // "content changed on disk after first RunSkill persistence, same run
    // continues" — the handler must not re-read disk for an already-loaded
    // (agentRunId, skillName) pair.
    await fs.writeFile(
      skillMdPath,
      "---\nname: mutable-skill\ndescription: test skill for mutation.\n---\nCHANGED BODY\n",
    );
    __resetSkillRegistryCacheForTests();

    const second = await loadSkillHandler({ skillName: "mutable-skill" }, { agentRunId: run.id });

    expect((second as { content: string }).content).toContain("ORIGINAL BODY");
    expect((second as { content: string }).content).not.toContain("CHANGED BODY");
    expect(await testDb.runSkill.count()).toBe(1);
    const row = await testDb.runSkill.findUniqueOrThrow({
      where: { agentRunId_skillName: { agentRunId: run.id, skillName: "mutable-skill" } },
    });
    expect(row.content).toContain("ORIGINAL BODY");
  });

  it("invalid input (missing skillName) returns a structured rejection and writes no row", async () => {
    const { run } = await makeChatAndRun();

    // @ts-expect-error — deliberately omitting the required field to exercise defensive validation.
    const result = await loadSkillHandler({}, { agentRunId: run.id });

    expect(result).toEqual({ error: expect.any(String), code: "malformed_tool_arguments" });
    expect(await testDb.runSkill.count()).toBe(0);
  });
});
