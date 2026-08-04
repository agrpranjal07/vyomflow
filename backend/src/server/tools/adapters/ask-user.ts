/**
 * `ask_user` local-tool registration (.claude/specs/S6-reliability-implementation-plan.md
 * §6.2a/§7.1). `kind: "local"` only for the model-facing registry — its
 * discovery (JSON Schema derivation in `listToolSpecs()`) reuses the same
 * mechanism as every other tool, so the model can call it with zero
 * orchestration-branch special-casing to be *found*. Its *dispatch* is not
 * the synchronous local-tool path, though: `turn.ts` intercepts
 * `call.name === "ask_user"` before reaching the generic `kind === "local"`
 * branch and suspends the run on a Waitpoint instead. This `handler` is
 * therefore unreachable in the real orchestration path — it exists only to
 * satisfy `LocalToolFields`'s required shape — and throws defensively if
 * ever invoked directly, so a future refactor that accidentally removes the
 * turn.ts interception fails loudly instead of silently no-opping.
 */
import type { ToolDefinition } from "@/server/tools/registry";
import { ASK_USER_TOOL_NAME, AskUserInputSchema, type AskUserInput } from "@/contracts/tools";

export const askUserTool: ToolDefinition<AskUserInput> = {
  kind: "local",
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user a clarifying question when their request is ambiguous, or confirm a proposed plan before executing it. Suspends the turn until the user responds.",
  inputSchema: AskUserInputSchema,
  handler() {
    throw new Error(
      "ask_user must be intercepted by turn.ts's dedicated waitpoint branch, never dispatched via the generic local-tool path.",
    );
  },
};
