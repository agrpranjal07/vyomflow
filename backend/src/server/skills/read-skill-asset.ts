/**
 * `read_skill_asset` tool handler. Delegates all filesystem-boundary security work to
 * `fs-boundary.ts::resolveSkillAssetPath` — this module only plumbs the registry lookup and
 * boundary result into the tool's input/output contract. No `RunSkill`-style durability record
 * here: per `.claude/specs/S5-skills.md` §B "read_skill_asset contract", the durability
 * requirement names skill *loads*, not individual asset reads — deliberately no DB row.
 */
import { promises as fs } from "fs";
import crypto from "crypto";
import {
  ReadSkillAssetInputSchema,
  ReadSkillAssetOutputSchema,
  type ReadSkillAssetInput,
} from "@/contracts/skills";
import { getSkillEntry } from "@/server/skills/registry";
import { resolveSkillAssetPath, type AssetRejectionReason } from "@/server/skills/fs-boundary";

export type ReadSkillAssetErrorCode =
  | "unknown_skill"
  | "malformed_tool_arguments"
  | AssetRejectionReason;

export interface ReadSkillAssetError {
  error: string;
  code: ReadSkillAssetErrorCode;
}

const ERROR_MESSAGES: Record<ReadSkillAssetErrorCode, string> = {
  unknown_skill: "Unknown skill name.",
  malformed_tool_arguments: "Invalid tool input.",
  invalid_asset_path: "Invalid asset path.",
  unsupported_asset_type: "Unsupported asset file type.",
  asset_too_large: "Asset file exceeds the size limit.",
  asset_not_found: "Asset file not found.",
};

function errorResult(code: ReadSkillAssetErrorCode): Record<string, unknown> {
  return { error: ERROR_MESSAGES[code], code };
}

/**
 * Matches `LocalToolFields["handler"]`'s signature:
 * `(input, ctx: { agentRunId }) => Promise<Record<string, unknown>>`.
 */
export async function readSkillAssetHandler(
  input: ReadSkillAssetInput,
  _ctx: { agentRunId: string },
): Promise<Record<string, unknown>> {
  const parsed = ReadSkillAssetInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorResult("malformed_tool_arguments");
  }
  const { skillName, assetPath } = parsed.data;

  const entry = await getSkillEntry(skillName);
  if (!entry) {
    return errorResult("unknown_skill");
  }

  const resolution = await resolveSkillAssetPath(entry.dirPath, assetPath);
  if (!resolution.ok) {
    return errorResult(resolution.reason);
  }

  const content = await fs.readFile(resolution.realPath, "utf8");
  const contentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const sizeBytes = Buffer.byteLength(content, "utf8");

  const output = { assetPath, content, contentHash, sizeBytes };
  return ReadSkillAssetOutputSchema.parse(output);
}
