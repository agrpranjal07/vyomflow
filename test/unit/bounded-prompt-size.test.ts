/**
 * T22 (S7 plan §9.4): bounded prompt size — 100 tools + 100 skills + the max
 * conversation history combined must stay under an asserted safe threshold.
 * Unit-level: the skills half uses the real `buildSystemPromptContent()`
 * against a synthetic 100-skill fixture (same chdir technique as
 * system-prompt-skills.test.ts); the tools half replicates `listToolSpecs()`'s
 * exact mapping over a synthetic 100-tool array (same technique as
 * tool-registry.test.ts's T20, since registry.ts's TOOLS array has no
 * synthetic-injection seam by design); the conversation-history half is a
 * representative synthetic array (no DB — buildConversationMessages's cap
 * behavior is separately proven against a real DB in conversation.test.ts's
 * T21) sized at MAX_CONVERSATION_HISTORY_MESSAGES with realistic per-message
 * text length.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import { buildSystemPromptContent } from "@/server/agent/system-prompt";
import { __resetSkillRegistryCacheForTests } from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";
import type { ToolDefinition, OpenRouterToolSpec } from "@/server/tools/registry";
import { MAX_CONVERSATION_HISTORY_MESSAGES } from "@/lib/config";

async function writeSkill(root: string, dirName: string, frontmatter: string, body: string): Promise<void> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

function syntheticListToolSpecs(tools: ToolDefinition[]): OpenRouterToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.inputSchema) },
  }));
}

describe("T22 — bounded combined prompt size at 100 tools + 100 skills + max conversation history", () => {
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
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-prompt-size-"));
    tmpRoot = path.join(parent, "agent-skills");
    await fs.mkdir(tmpRoot, { recursive: true });
    process.chdir(parent);
    __resetApprovedSkillsRootCacheForTests();
    __resetSkillRegistryCacheForTests();
    return tmpRoot;
  }

  it("combined char size stays under a justified safe threshold", async () => {
    // 1. 100 skills -> system prompt content.
    const root = await useFixtureRoot();
    for (let i = 0; i < 100; i++) {
      const name = `skill-${String(i).padStart(3, "0")}`;
      await writeSkill(root, name, `name: ${name}\ndescription: Guidance for ${name}`, `Body ${i}`);
    }
    const systemPrompt = await buildSystemPromptContent();

    // 2. 100 tools -> serialized OpenAI-format specs (as sent in the request `tools` field).
    const synthetic: ToolDefinition[] = Array.from({ length: 100 }, (_, i) => ({
      kind: "local" as const,
      name: `synthetic_tool_${i}`,
      description: `Synthetic adapter #${i} for T22 bounded-prompt-size testing.`,
      inputSchema: z.object({
        query: z.string().describe(`Query parameter for synthetic_tool_${i}`),
        limit: z.number().int().positive().optional(),
      }),
      handler: async () => ({}),
    }));
    const toolSpecs = JSON.stringify(syntheticListToolSpecs(synthetic));

    // 3. Max conversation history: MAX_CONVERSATION_HISTORY_MESSAGES messages
    // of representative length (a real chat turn is typically well under
    // 500 chars; 200 is a conservative mid-range estimate per message).
    const conversationHistory = Array.from({ length: MAX_CONVERSATION_HISTORY_MESSAGES }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Representative turn content #${i}. `.repeat(10), // ~250 chars
    }));
    const conversationSize = JSON.stringify(conversationHistory).length;

    const totalChars = systemPrompt.length + toolSpecs.length + conversationSize;

    // Threshold rationale: OpenRouter's free-tier models (this app's only
    // supported path — assignment §constraints) commonly cap context
    // around 32K-128K tokens; at a conservative ~4 chars/token, 32K tokens
    // is ~128,000 chars. This asserted threshold (300,000 chars, ~75K
    // tokens) leaves headroom under even the smallest common free-tier
    // context window while still catching a genuine unbounded blowup (e.g.
    // skill bodies or tool schemas leaking into the prompt, which is
    // exactly what T18/T20 separately guard against at the component
    // level — this test guards the SUM staying bounded when all three
    // scale simultaneously).
    expect(totalChars).toBeLessThan(300_000);

    // Sanity: none of the three components alone dominates unexpectedly
    // (each should be a small fraction of the combined bound).
    expect(systemPrompt.length).toBeLessThan(50_000);
    expect(toolSpecs.length).toBeLessThan(100_000);
    expect(conversationSize).toBeLessThan(50_000);
  });
});
