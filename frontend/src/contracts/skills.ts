// GENERATED — do not edit. Source: 0f5444fa8bbe10c41e18f0fbcc89a4c3d6dd047a:src/contracts/skills.ts
/**
 * S5 — Skills System. Pure Zod only, same rules as every other file under
 * src/contracts/** (00-master-spec.md §2): no Prisma types, no Next.js
 * types. Copied verbatim into the frontend by `contracts:sync`.
 */
import { z } from "zod";

export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const READ_SKILL_ASSET_TOOL_NAME = "read_skill_asset";

export const LoadSkillInputSchema = z.object({
  skillName: z.string().min(1).max(64),
});
export type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

export const ReadSkillAssetInputSchema = z.object({
  skillName: z.string().min(1).max(64),
  assetPath: z.string().min(1).max(512),
});
export type ReadSkillAssetInput = z.infer<typeof ReadSkillAssetInputSchema>;

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1).max(500),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const SkillMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

// Output validation for the two local skill tools (assignment: "validate
// tool input AND output with Zod").
export const LoadSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  contentHash: z.string(),
});
export type LoadSkillOutput = z.infer<typeof LoadSkillOutputSchema>;

export const ReadSkillAssetOutputSchema = z.object({
  assetPath: z.string(),
  content: z.string(),
  contentHash: z.string(),
  sizeBytes: z.number(),
});
export type ReadSkillAssetOutput = z.infer<typeof ReadSkillAssetOutputSchema>;
