import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import fssync from "fs";
import os from "os";
import path from "path";
import { resolveSkillAssetPath, MAX_ASSET_SIZE_BYTES } from "@/server/skills/fs-boundary";

describe("resolveSkillAssetPath", () => {
  let tmpRoot: string;
  let skillDir: string;
  let siblingSkillDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-fs-boundary-"));
    skillDir = path.join(tmpRoot, "crop-image-guidance");
    siblingSkillDir = path.join(tmpRoot, "gpt-image-2-guidance");
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.mkdir(siblingSkillDir, { recursive: true });
    // realpath the skill dir the same way the caller (registry) would.
    skillDir = await fs.realpath(skillDir);
    siblingSkillDir = await fs.realpath(siblingSkillDir);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("accepts a valid relative path within the skill dir", async () => {
    await fs.writeFile(path.join(skillDir, "assets", "checklist.md"), "hello");
    const result = await resolveSkillAssetPath(skillDir, "assets/checklist.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.realPath).toBe(path.join(skillDir, "assets", "checklist.md"));
    }
  });

  it("rejects a traversal path with invalid_asset_path", async () => {
    const result = await resolveSkillAssetPath(skillDir, "../../../etc/passwd");
    expect(result).toEqual({ ok: false, reason: "invalid_asset_path" });
  });

  it("rejects an absolute path with invalid_asset_path", async () => {
    const result = await resolveSkillAssetPath(skillDir, "/etc/passwd");
    expect(result).toEqual({ ok: false, reason: "invalid_asset_path" });
  });

  it("rejects a symlink inside the skill dir pointing outside it", async () => {
    const outsideFile = path.join(tmpRoot, "outside-secret.md");
    await fs.writeFile(outsideFile, "secret content");
    const linkPath = path.join(skillDir, "assets", "escape-link.md");
    fssync.symlinkSync(outsideFile, linkPath);

    const result = await resolveSkillAssetPath(skillDir, "assets/escape-link.md");
    expect(result).toEqual({ ok: false, reason: "invalid_asset_path" });
  });

  it("rejects an unsupported extension with unsupported_asset_type", async () => {
    await fs.writeFile(path.join(skillDir, "assets", "payload.exe"), "binary-ish");
    const result = await resolveSkillAssetPath(skillDir, "assets/payload.exe");
    expect(result).toEqual({ ok: false, reason: "unsupported_asset_type" });
  });

  it("rejects an oversized file with asset_too_large, checked via stat before read", async () => {
    const bigPath = path.join(skillDir, "assets", "big.md");
    const oversized = Buffer.alloc(MAX_ASSET_SIZE_BYTES + 1024, "a");
    await fs.writeFile(bigPath, oversized);
    const result = await resolveSkillAssetPath(skillDir, "assets/big.md");
    expect(result).toEqual({ ok: false, reason: "asset_too_large" });
  });

  it("rejects a missing file with asset_not_found", async () => {
    const result = await resolveSkillAssetPath(skillDir, "assets/does-not-exist.md");
    expect(result).toEqual({ ok: false, reason: "asset_not_found" });
  });

  it("rejects an attempt to resolve into a sibling skill's directory", async () => {
    await fs.writeFile(path.join(siblingSkillDir, "SKILL.md"), "sibling secret");
    // Even if a caller mistakenly passes a path that walks up and into a sibling directory,
    // the traversal check (and, if that were bypassed, the containment check) must reject it.
    const relativeToSibling = path.join(
      "..",
      path.basename(siblingSkillDir),
      "SKILL.md",
    );
    const result = await resolveSkillAssetPath(skillDir, relativeToSibling);
    expect(result).toEqual({ ok: false, reason: "invalid_asset_path" });
  });
});
