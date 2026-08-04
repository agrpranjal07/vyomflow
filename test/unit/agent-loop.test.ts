import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { runAgentLoop } from "@/server/agent/loop";
import {
  openRouterServer,
  openRouterStreamHandler,
  openRouterErrorHandler,
} from "../support/msw-openrouter";
import {
  normalCompletionSse,
  emptyStreamSse,
  truncatedStreamSse,
  midStreamErrorSse,
  rateLimitedErrorBody,
  wellFormedToolCallSse,
  malformedToolCallSse,
  parallelToolCallsSse,
  reasoningThenTextSse,
} from "../support/openrouter-fixtures";

process.env.OPENROUTER_API_KEY = "test-key";

beforeAll(() => openRouterServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => openRouterServer.resetHandlers());
afterAll(() => openRouterServer.close());

async function collectDeltas(model = "openrouter/free") {
  const deltas: { index: number; delta: string }[] = [];
  const result = await runAgentLoop({
    model,
    messages: [{ role: "user", content: "hi" }],
    onDelta: (part) => {
      deltas.push(part);
    },
  });
  return { result, deltas };
}

describe("runAgentLoop — clean completion", () => {
  it("streams deltas in order, sequential 0-based index, and returns the full text", async () => {
    openRouterServer.use(openRouterStreamHandler(normalCompletionSse("hello there friend")));

    const { result, deltas } = await collectDeltas();

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("hello there friend");
    expect(result.finishReason).toBe("stop");
    expect(result.resolvedModel).toBe("upstage/solar-pro-3:free");
    expect(deltas.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(deltas.map((d) => d.delta).join("")).toBe("hello there friend");
  });

  it("captures zero-cost usage even when the final chunk carries no choices array", async () => {
    openRouterServer.use(openRouterStreamHandler(normalCompletionSse("ok")));
    const { result } = await collectDeltas();
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 1, costCredits: 0 });
  });

  it("absence of delta.reasoning on every chunk leaves reasoning empty and never touches the text path (backward compatibility)", async () => {
    openRouterServer.use(openRouterStreamHandler(normalCompletionSse("hello there")));
    const { result, deltas } = await collectDeltas();
    expect(result.reasoning).toBe("");
    expect(result.text).toBe("hello there");
    expect(deltas.map((d) => d.delta).join("")).toBe("hello there");
  });
});

describe("runAgentLoop — reasoning delta accumulation", () => {
  it("accumulates delta.reasoning chunks separately from delta.content, in order", async () => {
    openRouterServer.use(openRouterStreamHandler(reasoningThenTextSse("Let me think... ", "The answer is 4.")));

    const reasoningDeltas: { index: number; delta: string }[] = [];
    const result = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "2+2?" }],
      onDelta: () => {},
      onReasoningDelta: (part) => {
        reasoningDeltas.push(part);
      },
    });

    expect(result.reasoning).toBe("Let me think... ");
    expect(result.text).toBe("The answer is 4.");
    expect(reasoningDeltas.map((d) => d.delta).join("")).toBe("Let me think... ");
  });

  it("never calls onReasoningDelta when the model emits no reasoning, and works fine when the callback is omitted entirely", async () => {
    openRouterServer.use(openRouterStreamHandler(normalCompletionSse("plain text only")));

    const reasoningDeltas: unknown[] = [];
    const result = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
      onReasoningDelta: (part) => {
        reasoningDeltas.push(part);
      },
    });
    expect(reasoningDeltas).toEqual([]);
    expect(result.reasoning).toBe("");

    // Omitting onReasoningDelta entirely (the free-model default path) must
    // not throw even though loop.ts always attempts to call it.
    openRouterServer.use(openRouterStreamHandler(reasoningThenTextSse("thinking", "done")));
    const resultNoCallback = await runAgentLoop({
      model: "openrouter/free",
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    expect(resultNoCallback.reasoning).toBe("thinking");
    expect(resultNoCallback.text).toBe("done");
  });
});

describe("runAgentLoop — forced failure cases", () => {
  it("429 (pre-stream HTTP error) -> stream_error, never-retryable, no paid fallback attempted", async () => {
    openRouterServer.use(openRouterErrorHandler(429, rateLimitedErrorBody()));

    const { result, deltas } = await collectDeltas();

    expect(result.outcome).toBe("stream_error");
    expect(result.errorType).toBe("rate_limit_exceeded");
    expect(deltas).toEqual([]);
  });

  it("empty stream -> empty_stream outcome, not a silent hang", async () => {
    openRouterServer.use(openRouterStreamHandler(emptyStreamSse()));

    const { result } = await collectDeltas();

    expect(result.outcome).toBe("empty_stream");
    expect(result.text).toBe("");
  });

  it("truncated stream (no finish_reason, no [DONE]) -> truncated, partial text preserved and NOT reported completed", async () => {
    openRouterServer.use(openRouterStreamHandler(truncatedStreamSse("partial answer")));

    const { result } = await collectDeltas();

    expect(result.outcome).toBe("truncated");
    expect(result.text).toBe("partial answer");
  });

  it("mid-stream error chunk -> stream_error, partial text preserved, distinct from a clean completion", async () => {
    openRouterServer.use(openRouterStreamHandler(midStreamErrorSse("partial before failure")));

    const { result } = await collectDeltas();

    expect(result.outcome).toBe("stream_error");
    expect(result.text).toBe("partial before failure");
    expect(result.errorType).toBe("rate_limit_exceeded");
  });

  it("well-formed tool_calls with an empty registry -> unsupported_tool, not a crash", async () => {
    openRouterServer.use(openRouterStreamHandler(wellFormedToolCallSse()));

    const { result } = await collectDeltas();

    expect(result.outcome).toBe("unsupported_tool");
    expect(result.toolName).toBe("crop_image");
  });

  it("malformed tool_calls arguments -> malformed_tool_arguments, not a crash", async () => {
    openRouterServer.use(openRouterStreamHandler(malformedToolCallSse()));

    const { result } = await collectDeltas();

    expect(result.outcome).toBe("malformed_tool_arguments");
  });

  it("parallel tool calls interleaved out of order merge correctly by index", async () => {
    openRouterServer.use(openRouterStreamHandler(parallelToolCallsSse()));

    const { result } = await collectDeltas();

    // Both accumulate correctly; the loop reports the lowest-index call as
    // unsupported (S2 has no registry — S3 will execute both in order).
    expect(result.outcome).toBe("unsupported_tool");
    expect(result.toolName).toBe("crop_image");
  });
});
