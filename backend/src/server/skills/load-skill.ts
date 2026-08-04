/**
 * `load_skill` local-tool handler (S5-skills.md §B "load_skill contract" /
 * "RunSkill persistence/dedup/resume behavior"). Standalone handler function
 * matching `LocalToolFields["handler"]` — not yet wired into
 * `server/tools/registry.ts`'s `TOOLS` array (a later task widens
 * `getToolDefinition`/`buildToolExecutor` for the `kind: "local"` branch).
 *
 * Self-validates input and output against the Zod contracts even though a
 * future executor may also validate input pre-call, since the assignment
 * requires Zod validation on both sides of every tool and nothing currently
 * guarantees a central pass will do it for local tools.
 */
import { prisma } from "@/lib/db";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { getSkillEntry } from "@/server/skills/registry";
import { LoadSkillInputSchema, LoadSkillOutputSchema, type LoadSkillInput } from "@/contracts/skills";

/**
 * Structured "expected failure" shape for a known/anticipated rejection
 * (unknown skill name, invalid input) — mirrors the codebase's existing
 * convention of never throwing for expected failures (see `turn.ts`'s
 * `failWithoutInvocation`), returning an error object a `tool_result` block
 * can carry instead. `code` is a stable machine-readable discriminant; a
 * later executor-wiring task is expected to set `isError: true` on the
 * `tool_result` block whenever a handler's result contains this shape.
 */
// A type alias, not an interface: interfaces have no implicit index
// signature, so an interface here would not satisfy the registry's
// `handler: (...) => Promise<Record<string, unknown>>` contract.
export type LoadSkillErrorResult = {
  error: string;
  code: "unknown_skill" | "malformed_tool_arguments";
};

export type LoadSkillHandlerResult = LoadSkillErrorResult | Record<string, unknown>;

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function loadSkillHandler(
  input: LoadSkillInput,
  ctx: { agentRunId: string },
): Promise<LoadSkillHandlerResult> {
  const parsedInput = LoadSkillInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      error: "The tool call's arguments did not match its expected shape.",
      code: "malformed_tool_arguments",
    };
  }
  const { skillName } = parsedInput.data;
  const { agentRunId } = ctx;

  const entry = await getSkillEntry(skillName);
  if (!entry) {
    return { error: `Unknown skill "${skillName}".`, code: "unknown_skill" };
  }

  // Durable resume: an existing row wins outright — never re-read disk, never
  // recompute the hash, even if the on-disk skill has since changed.
  const existing = await prisma.runSkill.findUnique({
    where: { agentRunId_skillName: { agentRunId, skillName } },
  });
  if (existing) {
    return LoadSkillOutputSchema.parse({
      name: entry.name,
      description: entry.description,
      content: existing.content,
      contentHash: existing.contentHash,
    });
  }

  let row;
  try {
    row = await prisma.runSkill.create({
      data: { agentRunId, skillName, contentHash: entry.contentHash, content: entry.bodyRaw },
    });
  } catch (error) {
    // Concurrent insert of the same (agentRunId, skillName) pair — e.g. two
    // tool calls in the same round naming the same skill. Fall back to the
    // read path rather than crashing; same idiom as ToolInvocation's
    // duplicate-dispatch guard.
    if (!isUniqueConstraintViolation(error)) throw error;
    row = await prisma.runSkill.findUniqueOrThrow({
      where: { agentRunId_skillName: { agentRunId, skillName } },
    });
  }

  return LoadSkillOutputSchema.parse({
    name: entry.name,
    description: entry.description,
    content: row.content,
    contentHash: row.contentHash,
  });
}
