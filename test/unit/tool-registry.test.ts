import { describe, it, expect } from "vitest";
import { z } from "zod";
import { getToolDefinition, listToolSpecs, type ToolDefinition, type OpenRouterToolSpec } from "@/server/tools/registry";
import { CROP_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME, MERGE_VIDEOS_TOOL_NAME, ASK_USER_TOOL_NAME } from "@/contracts/tools";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME } from "@/contracts/skills";

function engineOf(tool: ToolDefinition | undefined): string | undefined {
  return tool && tool.kind !== "local" ? tool.engine : undefined;
}

describe("registry", () => {
  it("looks up all three real media tools by name, each carrying its in-process engine", () => {
    expect(engineOf(getToolDefinition(CROP_IMAGE_TOOL_NAME))).toBe("sharp");
    expect(engineOf(getToolDefinition(GENERATE_IMAGE_TOOL_NAME))).toBe("cloudflare");
    expect(engineOf(getToolDefinition(MERGE_VIDEOS_TOOL_NAME))).toBe("ffmpeg");
  });

  it("media tools carry no `kind` (defaults to the media variant), unlike local tools", () => {
    for (const name of [CROP_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME, MERGE_VIDEOS_TOOL_NAME]) {
      const tool = getToolDefinition(name);
      expect(tool?.kind).toBeUndefined();
    }
  });

  it("looks up the local skill tools, which carry a handler instead of an engine", () => {
    for (const name of [LOAD_SKILL_TOOL_NAME, READ_SKILL_ASSET_TOOL_NAME]) {
      const tool = getToolDefinition(name);
      expect(tool?.kind).toBe("local");
      expect(tool && tool.kind === "local" ? typeof tool.handler : undefined).toBe("function");
    }
  });

  it("returns undefined for an unregistered name (never throws)", () => {
    expect(getToolDefinition("not_a_real_tool")).toBeUndefined();
  });

  it("derives one OpenAI-format tool spec per registered tool, straight from its Zod schema", () => {
    const specs = listToolSpecs();
    expect(specs).toHaveLength(6);
    expect(specs.map((s) => s.function.name).sort()).toEqual(
      [
        CROP_IMAGE_TOOL_NAME,
        GENERATE_IMAGE_TOOL_NAME,
        MERGE_VIDEOS_TOOL_NAME,
        LOAD_SKILL_TOOL_NAME,
        READ_SKILL_ASSET_TOOL_NAME,
        ASK_USER_TOOL_NAME,
      ].sort(),
    );
    for (const spec of specs) {
      expect(spec.type).toBe("function");
      expect(spec.function.parameters).toBeTypeOf("object");
    }
  });
});

// T20 (S7 plan §9.4): registry.ts's TOOLS array is a fixed compile-time
// list (adding tool #N is "a new adapter file plus one line in TOOLS" —
// there is no dynamic/synthetic-injection seam by design). To exercise
// listToolSpecs()'s *scaling behavior* at 100 tools without adding a real
// test-only injection seam to production code, this test replicates its
// exact mapping (name/description/`z.toJSONSchema(inputSchema)`, straight
// from registry.ts's own implementation) over 100 synthetic adapters
// shaped identically to a real `ToolDefinition`.
describe("listToolSpecs scaling shape — synthetic 100-tool registry (T20)", () => {
  function syntheticListToolSpecs(tools: ToolDefinition[]): OpenRouterToolSpec[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.inputSchema),
      },
    }));
  }

  it("100 tool adapters all produce valid JSON Schema entries, bounded serialized size", () => {
    const count = 100;
    const synthetic: ToolDefinition[] = Array.from({ length: count }, (_, i) => ({
      kind: "local" as const,
      name: `synthetic_tool_${i}`,
      description: `Synthetic adapter #${i} for T20 scale testing.`,
      inputSchema: z.object({
        query: z.string().describe(`Query parameter for synthetic_tool_${i}`),
        limit: z.number().int().positive().optional(),
      }),
      handler: async () => ({}),
    }));

    const specs = syntheticListToolSpecs(synthetic);

    expect(specs).toHaveLength(count);
    const names = new Set(specs.map((s) => s.function.name));
    expect(names.size).toBe(count); // no name collisions

    for (const spec of specs) {
      expect(spec.type).toBe("function");
      expect(typeof spec.function.name).toBe("string");
      expect(typeof spec.function.description).toBe("string");
      // Each parameters blob is a valid JSON Schema object (has a "type"
      // and "properties", the shape z.toJSONSchema always emits for an
      // object schema).
      const params = spec.function.parameters as { type?: string; properties?: unknown };
      expect(params.type).toBe("object");
      expect(params.properties).toBeTypeOf("object");
    }

    // Threshold rationale: each entry is ~150-250 bytes of JSON (short
    // name, one-line description, a 2-field object schema) — 100 entries
    // is on the order of 20KB. 100_000 bytes (100KB) is a ~5x margin over
    // that estimate, generous enough for real tools with richer schemas
    // (crop_image/generate_image/merge_videos have more fields than this
    // synthetic fixture) while still catching an unbounded blowup (e.g. a
    // schema accidentally embedding large enum/example data).
    const serializedSize = JSON.stringify(specs).length;
    expect(serializedSize).toBeLessThan(100_000);
  });
});
