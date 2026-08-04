import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import crypto from "crypto";
import path from "path";
import { readSkillAssetHandler } from "@/server/skills/read-skill-asset";
import { __resetSkillRegistryCacheForTests } from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";

const REAL_BACKEND_DIR = path.resolve(__dirname, "../../backend");
const CTX = { agentRunId: "test-run-id" };

describe("readSkillAssetHandler", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(REAL_BACKEND_DIR);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
  });

  it("reads the real prompt-checklist.md asset with correct content/hash/size", async () => {
    const result = await readSkillAssetHandler(
      { skillName: "generate-image-guidance", assetPath: "assets/prompt-checklist.md" },
      CTX,
    );

    expect(result).not.toHaveProperty("error");
    const raw = await fs.readFile(
      path.join(REAL_BACKEND_DIR, "agent-skills/generate-image-guidance/assets/prompt-checklist.md"),
      "utf8",
    );
    const expectedHash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

    expect(result.assetPath).toBe("assets/prompt-checklist.md");
    expect(result.content).toBe(raw);
    expect(result.contentHash).toBe(expectedHash);
    expect(result.sizeBytes).toBe(Buffer.byteLength(raw, "utf8"));
  });

  it("returns unknown_skill for a nonexistent skill name, no crash", async () => {
    const result = await readSkillAssetHandler(
      { skillName: "does-not-exist", assetPath: "assets/foo.md" },
      CTX,
    );
    expect(result).toEqual({ error: expect.any(String), code: "unknown_skill" });
  });

  it("returns invalid_asset_path for a path traversal attempt", async () => {
    const result = await readSkillAssetHandler(
      { skillName: "generate-image-guidance", assetPath: "../../../etc/passwd" },
      CTX,
    );
    expect(result).toEqual({ error: expect.any(String), code: "invalid_asset_path" });
  });

  it("returns asset_not_found for a missing asset in a real skill directory", async () => {
    const result = await readSkillAssetHandler(
      { skillName: "generate-image-guidance", assetPath: "assets/does-not-exist.md" },
      CTX,
    );
    expect(result).toEqual({ error: expect.any(String), code: "asset_not_found" });
  });

  it("rejects invalid input missing skillName", async () => {
    const result = await readSkillAssetHandler(
      // @ts-expect-error deliberately malformed input
      { assetPath: "assets/prompt-checklist.md" },
      CTX,
    );
    expect(result).toEqual({ error: expect.any(String), code: "malformed_tool_arguments" });
  });

  it("rejects invalid input missing assetPath", async () => {
    const result = await readSkillAssetHandler(
      // @ts-expect-error deliberately malformed input
      { skillName: "generate-image-guidance" },
      CTX,
    );
    expect(result).toEqual({ error: expect.any(String), code: "malformed_tool_arguments" });
  });
});
