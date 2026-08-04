import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { runAgentLoop, type ResolvedToolCall, type ToolExecutionResult } from "@/server/agent/loop";
import { openRouterServer, openRouterSequentialStreamHandler } from "../support/msw-openrouter";
import { normalCompletionSse, wellFormedToolCallSse, parallelToolCallsSse } from "../support/openrouter-fixtures";

process.env.OPENROUTER_API_KEY = "test-key";

beforeAll(() => openRouterServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => openRouterServer.resetHandlers());
afterAll(() => openRouterServer.close());

describe("runAgentLoop — multi-turn tool execution", () => {
  it("executes a tool call and re-enters the model with the result, accumulating text across both rounds", async () => {
    openRouterServer.use(
      openRouterSequentialStreamHandler([wellFormedToolCallSse(), normalCompletionSse("cropped it for you")]),
    );

    const executed: ResolvedToolCall[][] = [];
    const result = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "crop this" }],
      onDelta: () => {},
      onToolCalls: async (calls): Promise<ToolExecutionResult[]> => {
        executed.push(calls);
        return calls.map((c) => ({ id: c.id, output: { resultUrls: ["https://out.example.com/c.png"] }, isError: false }));
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("cropped it for you");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual([{ id: "call_1", name: "crop_image", args: { x_percent: 10 } }]);
  });

  it("executes all accumulated parallel calls, not just the first, in model-emitted order", async () => {
    openRouterServer.use(
      openRouterSequentialStreamHandler([parallelToolCallsSse(), normalCompletionSse("done")]),
    );

    const executed: ResolvedToolCall[][] = [];
    const result = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "do both" }],
      onDelta: () => {},
      onToolCalls: async (calls): Promise<ToolExecutionResult[]> => {
        executed.push(calls);
        return calls.map((c) => ({ id: c.id, output: {}, isError: false }));
      },
    });

    expect(result.outcome).toBe("completed");
    expect(executed[0].map((c) => c.name)).toEqual(["crop_image", "merge_videos"]);
    expect(executed[0].map((c) => c.id)).toEqual(["call_1", "call_2"]);
  });

  it("bounds re-entry at MAX_AGENT_TURNS when the model keeps calling tools forever", async () => {
    // Every round returns the same tool_calls fixture — the model never stops.
    openRouterServer.use(
      openRouterSequentialStreamHandler(Array.from({ length: 10 }, () => wellFormedToolCallSse())),
    );

    const result = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "loop forever" }],
      onDelta: () => {},
      onToolCalls: async (calls) => calls.map((c) => ({ id: c.id, output: {}, isError: false })),
    });

    expect(result.outcome).toBe("max_turns_exceeded");
    // The final round's chunkCount/resolvedModel must not be silently
    // discarded — every other terminal outcome forwards them.
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.resolvedModel).toBe("upstage/solar-pro-3:free");
  });

  it("fires onRoundUsage once per round that reports usage, with the correct turnIndex each time", async () => {
    openRouterServer.use(
      openRouterSequentialStreamHandler([wellFormedToolCallSse(), normalCompletionSse("done")]),
    );

    const rounds: number[] = [];
    await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "crop this" }],
      onDelta: () => {},
      onToolCalls: async (calls) => calls.map((c) => ({ id: c.id, output: {}, isError: false })),
      onRoundUsage: ({ turnIndex }) => {
        rounds.push(turnIndex);
      },
    });

    // wellFormedToolCallSse's fixture carries no usage chunk (tool_calls
    // finish reason, no [DONE]-adjacent usage line), only the final round does.
    expect(rounds).toEqual([1]);
  });
});
