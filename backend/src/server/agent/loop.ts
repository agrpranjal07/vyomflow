/**
 * Hand-rolled, provider-neutral agent loop over OpenRouter's OpenAI-
 * compatible streaming chat-completions API (00-master-spec.md §1: no
 * `@openrouter/agent`, no paid fallback). S2 registers no tools yet, but
 * the tool_calls delta merge-by-`index` shape must already be correct so
 * S3 doesn't have to rewrite this file (S2-streaming-turn.md, explicit).
 *
 * Three terminal outcomes are never collapsed into one another
 * (S2 implementation plan §E):
 *   - "completed"   — finish_reason in {stop, length, content_filter}, or
 *                      [DONE] with no error seen.
 *   - "stream_error" — a chunk carried a top-level `error` (or
 *                      finish_reason === "error").
 *   - "truncated"    — the reader hit EOF with neither of the above.
 * Plus two S2-specific terminal outcomes for the empty-registry case:
 *   - "unsupported_tool"        — a well-formed tool call, but nothing is
 *                                  registered to execute it (S2 has no
 *                                  tools; this is itself one of the
 *                                  "malformed/unsupported" cases the spec
 *                                  requires failing gracefully on).
 *   - "malformed_tool_arguments" — the accumulated `arguments` string
 *                                   never parses as JSON.
 * And one defensive cap:
 *   - "max_turns_exceeded" — MAX_AGENT_TURNS iterations without a terminal
 *                             finish_reason (a model that never stops).
 */
import { MAX_AGENT_TURNS } from "@/lib/config";
import { requestOpenRouterCompletion, type OpenRouterMessage } from "@/server/openrouter/client";
import { parseSseStream, SSE_DONE_SENTINEL } from "@/server/openrouter/sse";
import {
  classifyOpenRouterError,
  parseOpenRouterErrorBody,
  OpenRouterErrorPayloadSchema,
  type OpenRouterErrorPayload,
} from "@/server/openrouter/errors";

interface OpenRouterToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterDelta {
  role?: string;
  content?: string | null;
  /**
   * Reasoning-capture task: OpenRouter's chat-completions SSE deltas can
   * carry a plain-string `reasoning` field (alias `reasoning_content`) for
   * models returning raw reasoning text — verified via Context7
   * (openrouter.ai/docs/guides/best-practices/reasoning-tokens, 2026-08-21).
   * The structured `reasoning_details` array (typed reasoning blocks, e.g.
   * Anthropic) is out of scope here — only this plain-string field is
   * parsed; absent on non-reasoning models/free-tier chunks, which is the
   * common case and must remain a no-op.
   */
  reasoning?: string | null;
  tool_calls?: OpenRouterToolCallDelta[];
}

interface OpenRouterChoice {
  index?: number;
  delta?: OpenRouterDelta;
  finish_reason?: string | null;
  error?: OpenRouterErrorPayload;
}

interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
}

interface OpenRouterChunk {
  id?: string;
  model?: string;
  choices?: OpenRouterChoice[];
  error?: OpenRouterErrorPayload;
  usage?: OpenRouterUsage;
}

export type LoopOutcome =
  | "completed"
  | "stream_error"
  | "truncated"
  | "empty_stream"
  | "unsupported_tool"
  | "malformed_tool_arguments"
  | "max_turns_exceeded";

export interface LoopResult {
  outcome: LoopOutcome;
  text: string;
  /** Accumulated `delta.reasoning` text for this result, "" when the model/round emitted none. */
  reasoning: string;
  chunkCount: number;
  finishReason?: string | null;
  generationId?: string;
  resolvedModel?: string;
  usage?: { promptTokens: number; completionTokens: number; costCredits: number };
  errorCode?: string;
  errorType?: string;
  userMessage?: string;
  toolName?: string;
}

export interface ResolvedToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolExecutionResult {
  id: string;
  /** JSON-serializable — becomes the "tool" role message's content sent back to the model. */
  output: unknown;
  isError: boolean;
}

export interface RunAgentLoopParams {
  model: string;
  messages: OpenRouterMessage[];
  /** OpenAI-format tool specs (registry.ts's listToolSpecs()). Omitted -> no tools offered to the model. */
  tools?: unknown[];
  signal?: AbortSignal;
  /** Called once per non-empty content delta, in order, 0-indexed. */
  onDelta: (part: { index: number; delta: string }) => Promise<void> | void;
  /** Called once per non-empty `delta.reasoning` chunk, mirroring `onDelta` exactly. Never called for models/rounds that emit no reasoning. */
  onReasoningDelta?: (part: { index: number; delta: string }) => Promise<void> | void;
  /**
   * Executes one round's accumulated, well-formed tool calls and returns
   * one result per call, order-independent (matched back by `id`).
   * Orchestration-owned side effects — the loop never dispatches a tool
   * itself (Core Concepts: "Isolated — tools do not mutate chat state
   * directly"). When omitted, any well-formed tool call terminates the
   * turn with outcome "unsupported_tool" (S2's zero-tool behavior,
   * preserved for callers/tests that don't wire an executor).
   */
  onToolCalls?: (calls: ResolvedToolCall[], turnIndex: number) => Promise<ToolExecutionResult[]>;
  /**
   * Fires once per OpenRouter round that reports `usage` — including every
   * intermediate tool round, not just the final one (cross-spec
   * consistency-gate finding: `recordUsage`'s per-round idempotency key
   * means each round's usage must be recorded separately or earlier
   * rounds' token usage is silently dropped).
   */
  onRoundUsage?: (round: {
    turnIndex: number;
    usage: { promptTokens: number; completionTokens: number; costCredits: number };
    resolvedModel?: string;
    generationId?: string;
  }) => Promise<void> | void;
}

interface ToolCallAccumulator {
  id?: string;
  type?: string;
  name: string;
  args: string;
}

/**
 * Merges tool_calls deltas by `index` (OpenAI-compatible accumulation
 * inherited by compatibility — OpenRouter does not document this shape at
 * all, and its own published streaming example is buggy: naive `push`
 * instead of merge, and reads `delta.finish_reason` which never fires
 * since finish_reason lives on the choice, not the delta. Verified during
 * planning; do not copy that example).
 */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: OpenRouterToolCallDelta[] | undefined,
): void {
  if (!deltas) return;
  for (const delta of deltas) {
    const key = delta.index ?? 0;
    const existing = accumulators.get(key) ?? { name: "", args: "" };
    if (delta.id && !existing.id) existing.id = delta.id;
    if (delta.type && !existing.type) existing.type = delta.type;
    if (delta.function?.name) existing.name += delta.function.name;
    if (delta.function?.arguments) existing.args += delta.function.arguments;
    accumulators.set(key, existing);
  }
}

async function streamOneCompletion(
  params: RunAgentLoopParams,
  startIndex: number,
): Promise<{
  result: LoopResult;
  toolCalls: Map<number, ToolCallAccumulator>;
  nextIndex: number;
}> {
  const response = await requestOpenRouterCompletion({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    signal: params.signal,
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const payload = parseOpenRouterErrorBody(body);
    const classified = payload
      ? classifyOpenRouterError(payload, response.status)
      : classifyOpenRouterError(
          { code: response.status, message: response.statusText || "OpenRouter request failed." },
          response.status,
        );
    return {
      result: {
        outcome: "stream_error",
        text: "",
        reasoning: "",
        chunkCount: 0,
        errorCode: classified.errorCode,
        errorType: classified.errorType,
        userMessage: classified.userMessage,
      },
      toolCalls: new Map(),
      nextIndex: startIndex,
    };
  }

  if (!response.body) {
    return {
      result: { outcome: "empty_stream", text: "", reasoning: "", chunkCount: 0 },
      toolCalls: new Map(),
      nextIndex: startIndex,
    };
  }

  let text = "";
  let reasoning = "";
  let chunkCount = 0;
  let sawDone = false;
  let finishReason: string | null | undefined;
  let resolvedModel: string | undefined;
  let generationId: string | undefined;
  let usage: LoopResult["usage"];
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let index = startIndex;

  for await (const raw of parseSseStream(response.body)) {
    if (raw === SSE_DONE_SENTINEL) {
      sawDone = true;
      break;
    }

    let chunk: OpenRouterChunk;
    try {
      chunk = JSON.parse(raw) as OpenRouterChunk;
    } catch {
      // Not documented as ever occurring, but never crash the turn on a
      // malformed line — skip it and keep reading.
      continue;
    }
    chunkCount++;

    if (chunk.id && !generationId) generationId = chunk.id;
    if (chunk.model && !resolvedModel) resolvedModel = chunk.model;

    // Top-level `error` first (the documented mid-stream shape), then the
    // per-choice `error` as a fallback — both positions are legal per the
    // non-streaming schema.
    const topLevelError = chunk.error;
    const choice = chunk.choices?.[0];
    const choiceError = choice?.error;
    const errorPayload = topLevelError ?? choiceError;
    if (errorPayload) {
      const parsed = OpenRouterErrorPayloadSchema.safeParse(errorPayload);
      const classified = parsed.success
        ? classifyOpenRouterError(parsed.data)
        : classifyOpenRouterError({ code: "unknown", message: "Unrecognized error payload." });
      return {
        result: {
          outcome: "stream_error",
          text,
          reasoning,
          chunkCount,
          resolvedModel,
          generationId,
          errorCode: classified.errorCode,
          errorType: classified.errorType,
          userMessage: classified.userMessage,
          usage,
        },
        toolCalls,
        nextIndex: index,
      };
    }

    if (choice?.delta?.content) {
      text += choice.delta.content;
      await params.onDelta({ index, delta: choice.delta.content });
      index++;
    }

    if (choice?.delta?.reasoning) {
      reasoning += choice.delta.reasoning;
      if (params.onReasoningDelta) {
        await params.onReasoningDelta({ index, delta: choice.delta.reasoning });
        index++;
      }
    }

    mergeToolCallDeltas(toolCalls, choice?.delta?.tool_calls);

    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        // openrouter/free is always zero app-credit cost regardless of
        // what OpenRouter's own `usage.cost` reports (00-master-spec.md
        // §4 — "record only, never debited").
        costCredits: 0,
      };
    }
  }

  // Zero chunks at all — whether the stream ended via [DONE] with nothing
  // in between, or just closed — is the "empty stream" case, distinct from
  // a genuine mid-generation truncation.
  if (chunkCount === 0) {
    return { result: { outcome: "empty_stream", text, reasoning, chunkCount }, toolCalls, nextIndex: index };
  }

  if (!sawDone && finishReason === undefined) {
    return {
      result: { outcome: "truncated", text, reasoning, chunkCount, resolvedModel, generationId, usage },
      toolCalls,
      nextIndex: index,
    };
  }

  // `finish_reason === "error"` without an accompanying `error` payload on
  // any chunk (the payload-carrying case already returned above) is still
  // documented as a real upstream failure, not a normal completion — never
  // collapse it into "completed" (S2-streaming-turn.md §8 correction).
  if (finishReason === "error") {
    return {
      result: {
        outcome: "stream_error",
        text,
        reasoning,
        chunkCount,
        resolvedModel,
        generationId,
        errorCode: "error",
        errorType: "error",
        userMessage: "The AI response could not be completed. Please try again.",
        usage,
      },
      toolCalls,
      nextIndex: index,
    };
  }

  return {
    result: {
      outcome: "completed",
      text,
      reasoning,
      chunkCount,
      finishReason: finishReason ?? null,
      resolvedModel,
      generationId,
      usage,
    },
    toolCalls,
    nextIndex: index,
  };
}

function parseToolArguments(accumulator: ToolCallAccumulator): unknown | typeof MALFORMED {
  try {
    return accumulator.args.length > 0 ? JSON.parse(accumulator.args) : {};
  } catch {
    return MALFORMED;
  }
}
const MALFORMED = Symbol("malformed-tool-arguments");

export async function runAgentLoop(params: RunAgentLoopParams): Promise<LoopResult> {
  let streamIndex = 0;
  let accumulatedText = "";
  let accumulatedReasoning = "";
  const workingMessages = [...params.messages];
  let lastChunkCount = 0;
  let lastResolvedModel: string | undefined;
  let lastGenerationId: string | undefined;
  let lastUsage: LoopResult["usage"];

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const { result, toolCalls, nextIndex } = await streamOneCompletion(
      { ...params, messages: workingMessages },
      streamIndex,
    );
    streamIndex = nextIndex;
    lastChunkCount = result.chunkCount;
    if (result.resolvedModel) lastResolvedModel = result.resolvedModel;
    if (result.generationId) lastGenerationId = result.generationId;
    if (result.usage) lastUsage = result.usage;
    // Accumulate, never overwrite — S2's bug: each round's text replaced
    // the running total, silently dropping every earlier round's text once
    // a second round (tool round) occurred. Reasoning mirrors the same rule.
    accumulatedText += result.text;
    accumulatedReasoning += result.reasoning;

    if (result.usage) {
      await params.onRoundUsage?.({
        turnIndex: turn,
        usage: result.usage,
        resolvedModel: result.resolvedModel,
        generationId: result.generationId,
      });
    }

    if (result.outcome !== "completed") {
      return { ...result, text: accumulatedText, reasoning: accumulatedReasoning };
    }

    if (result.finishReason !== "tool_calls" || toolCalls.size === 0) {
      // Clean completion (stop/length/content_filter) — no tool_calls, or
      // the model claimed tool_calls but emitted none (malformed but
      // harmless): treat as a normal completed turn either way.
      return { ...result, text: accumulatedText, reasoning: accumulatedReasoning };
    }

    // finish_reason === "tool_calls" with at least one accumulated call,
    // in model-emitted order (assignment §7 "message ordering stays
    // deterministic"). JSON.parse failure on any call's arguments ends the
    // turn — a malformed call from one tool doesn't invalidate any other
    // already-resolved call, but partial tool execution with one
    // unparseable member is not a state worth recovering from mid-loop.
    const orderedCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    const resolved: ResolvedToolCall[] = [];
    for (let callIndex = 0; callIndex < orderedCalls.length; callIndex++) {
      const call = orderedCalls[callIndex];
      const parsedArgs = parseToolArguments(call);
      if (parsedArgs === MALFORMED) {
        return {
          outcome: "malformed_tool_arguments",
          text: accumulatedText,
          reasoning: accumulatedReasoning,
          chunkCount: result.chunkCount,
          resolvedModel: result.resolvedModel,
          generationId: result.generationId,
          toolName: call.name || undefined,
          userMessage: "The model attempted a tool call with malformed arguments.",
        };
      }
      // OpenRouter always sends a per-call `id`, but a missing/empty one
      // (defensive) must never collapse multiple parallel calls onto the
      // same key — both the `byId` result lookup below and the
      // ToolInvocation row's `@@unique([agentRunId, toolCallId])` guard
      // would collide on a shared "" id.
      resolved.push({ id: call.id || `synthetic:${turn}:${callIndex}`, name: call.name, args: parsedArgs });
    }

    if (!params.onToolCalls) {
      // No executor wired — S2's zero-tool behavior (also what any test
      // that doesn't need real tool execution gets by default).
      const [first] = resolved;
      return {
        outcome: "unsupported_tool",
        text: accumulatedText,
        reasoning: accumulatedReasoning,
        chunkCount: result.chunkCount,
        resolvedModel: result.resolvedModel,
        generationId: result.generationId,
        toolName: first.name || "unknown",
        userMessage: `The model attempted to use a tool ("${first.name || "unknown"}") that is not yet available.`,
      };
    }

    workingMessages.push({
      role: "assistant",
      content: result.text.length > 0 ? result.text : null,
      tool_calls: resolved.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    });

    const toolResults = await params.onToolCalls(resolved, turn);
    const byId = new Map(toolResults.map((r) => [r.id, r]));
    for (const call of resolved) {
      const toolResult = byId.get(call.id);
      workingMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(toolResult?.output ?? { error: "No result was returned for this tool call." }),
      });
    }
    // Re-enter the model with the tool results appended — next loop iteration.
  }

  return {
    outcome: "max_turns_exceeded",
    text: accumulatedText,
    reasoning: accumulatedReasoning,
    chunkCount: lastChunkCount,
    resolvedModel: lastResolvedModel,
    generationId: lastGenerationId,
    usage: lastUsage,
    userMessage: "The turn exceeded the maximum number of steps.",
  };
}
