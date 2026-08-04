/**
 * The one authoritative tool registry (assignment §2: "Tool discovery,
 * input validation, execution, credit estimation, and result rendering must
 * derive from one authoritative registry. Adding a tool should not require
 * editing unrelated orchestration branches."). Orchestration code (the
 * agent loop, the media-tool child task, persistence) calls only `get()` and
 * `listToolSpecs()` — it never imports an adapter file directly, so adding
 * tool #4 is a new adapter file plus one line in TOOLS below.
 */
import { z } from "zod";
import { cropImageTool } from "@/server/tools/adapters/crop-image";
import { generateImageTool } from "@/server/tools/adapters/generate-image";
import { mergeVideosTool } from "@/server/tools/adapters/merge-videos";
import {
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_ASSET_TOOL_NAME,
  LoadSkillInputSchema,
  LoadSkillOutputSchema,
  ReadSkillAssetInputSchema,
  ReadSkillAssetOutputSchema,
  type LoadSkillInput,
  type ReadSkillAssetInput,
} from "@/contracts/skills";
import { loadSkillHandler } from "@/server/skills/load-skill";
import { readSkillAssetHandler } from "@/server/skills/read-skill-asset";
import { askUserTool } from "@/server/tools/adapters/ask-user";

/** Fields every tool exposes to the model — the only ones `listToolSpecs()` reads. */
interface ToolCommonFields<TInput> {
  name: string;
  description: string;
  /** Single source of truth for validation, the model-facing JSON Schema, and the sanitized-input snapshot. */
  inputSchema: z.ZodType<TInput>;
}

/** Which in-process engine a media tool's `execute` uses — informational only, not persisted under this name (see `ToolInvocation.nodeType`, which keeps persisting `tool.name`). */
export type MediaEngine = "sharp" | "cloudflare" | "ffmpeg";

/** One produced result file, in whichever form is cheapest for the adapter to hand back. */
export type MediaArtifact =
  | { kind: "bytes"; body: Uint8Array; contentType: string; filename: string }
  | { kind: "file"; path: string; contentType: string; filename: string }
  | { kind: "url"; url: string }; // durable passthrough → existing ingestGeneratedAssets

export interface MediaToolResult {
  artifacts: MediaArtifact[];
  creditUsedApp?: number;
}

/** Per-invocation execution context handed to a media tool's `execute` — built and torn down by `tool.ts`, never by the adapter. */
export interface MediaToolContext {
  toolInvocationId: string;
  agentRunId: string;
  ownerId: string;
  /** Created (and `rm -rf`'d) by `tool.ts`; adapters never `mkdtemp` their own. */
  workDir: string;
  /** Task cancel ∧ per-tool budget, forwarded to every `fetch`/`execFile` the adapter makes. */
  signal: AbortSignal;
}

/** A billable, async tool executed in-process against a local/free engine (sharp, Cloudflare Workers AI, ffmpeg) via the `media-tool` child task. */
export interface MediaToolFields<TInput = unknown> extends ToolCommonFields<TInput> {
  /** Which engine this tool executes against — informational/logging only. */
  engine: MediaEngine;
  /** Conservative pre-dispatch credit estimate (D2 hold top-up) — capture always settles at the tool's own reported creditUsedApp, falling back to this estimate. */
  estimateCredits(input: TInput): number;
  /**
   * Optional override of the flat per-engine execution budget (`ENGINE_BUDGET_MS`
   * in tool.ts) for this specific input — e.g. `generate_image` makes N
   * sequential provider calls for `n > 1`, so a flat single-call budget
   * would abort a request that was still making legitimate progress.
   * `tool.ts` still caps the result at MEDIA_TOOL_EXEC_DEADLINE_MS.
   */
  estimateBudgetMs?(input: TInput): number;
  /** Runs the tool against the validated input, producing zero or more artifacts. */
  execute(input: TInput, ctx: MediaToolContext): Promise<MediaToolResult>;
}

/** A free, synchronous tool executed in-process — no dispatch, no ToolInvocation row, no credit hold. */
export interface LocalToolFields<TInput = unknown> extends ToolCommonFields<TInput> {
  outputSchema?: z.ZodType<unknown>;
  handler(input: TInput, ctx: { agentRunId: string }): Promise<Record<string, unknown>>;
}

/**
 * `kind` is optional on the media variant and defaults to `"media"`, so adapters written
 * before the discriminant existed satisfy the union unchanged.
 */
export type ToolDefinition<TInput = unknown> =
  | (MediaToolFields<TInput> & { kind?: "media" })
  | (LocalToolFields<TInput> & { kind: "local" });

/** Skills are guidance text, not billable work — hence `kind: "local"` (S5-skills.md §B). */
const loadSkillTool: ToolDefinition<LoadSkillInput> = {
  kind: "local",
  name: LOAD_SKILL_TOOL_NAME,
  description:
    "Load a skill's full guidance content by name. Call this before using a skill you haven't loaded yet in this conversation.",
  inputSchema: LoadSkillInputSchema,
  outputSchema: LoadSkillOutputSchema,
  handler: loadSkillHandler,
};

const readSkillAssetTool: ToolDefinition<ReadSkillAssetInput> = {
  kind: "local",
  name: READ_SKILL_ASSET_TOOL_NAME,
  description:
    "Read a small asset file (e.g. a checklist) belonging to an already-loaded skill, by its relative path.",
  inputSchema: ReadSkillAssetInputSchema,
  outputSchema: ReadSkillAssetOutputSchema,
  handler: readSkillAssetHandler,
};

const TOOLS: ToolDefinition[] = [
  cropImageTool,
  generateImageTool,
  mergeVideosTool,
  loadSkillTool,
  readSkillAssetTool,
  askUserTool,
];

const registry = new Map<string, ToolDefinition>(TOOLS.map((tool) => [tool.name, tool]));

/**
 * O(1) lookup by registry name (the OpenRouter tool_call's `function.name`), returning the full
 * union — `turn.ts`'s executor discriminates on `kind`: `"local"` runs in-process synchronously,
 * everything else takes the media-tool dispatch path (`tool.ts` child task).
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export interface OpenRouterToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

/** Derives the OpenAI-format tool specs the model sees, straight from each adapter's Zod inputSchema. */
export function listToolSpecs(): OpenRouterToolSpec[] {
  return TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema),
    },
  }));
}
