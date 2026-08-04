/**
 * Literal OpenRouter SSE wire-format fixtures — one builder per forced test
 * case from S2-streaming-turn.md ("Tests" section: 429, empty stream,
 * malformed tool-call delta, mid-stream error chunk, normal completion).
 * Shapes verified during S2 planning against openrouter.ai/docs/
 * api_reference/{streaming,errors-and-debugging}; the streaming tool_calls
 * delta shape specifically is NOT documented by OpenRouter and is written
 * against the OpenAI-compatible spec instead (flagged in the S2 plan).
 */

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const OPENROUTER_KEEPALIVE_LINE = ": OPENROUTER PROCESSING\n\n";
export const OPENROUTER_DONE_LINE = "data: [DONE]\n\n";

const GEN_ID = "gen-fixture-1";
const MODEL = "upstage/solar-pro-3:free";

/** A clean multi-chunk completion, word by word, ending in [DONE]. */
export function normalCompletionSse(text: string, model = MODEL): string {
  const words = text.split(" ");
  let out = OPENROUTER_KEEPALIVE_LINE;
  words.forEach((word, i) => {
    out += sseLine({
      id: GEN_ID,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: i === 0 ? { role: "assistant", content: word } : { content: ` ${word}` },
          finish_reason: null,
        },
      ],
    });
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  // Final usage-only chunk — documented as sometimes carrying no `choices`
  // at all (S2 plan §E); exercised here deliberately.
  out += sseLine({
    object: "chat.completion.chunk",
    usage: {
      prompt_tokens: 12,
      completion_tokens: words.length,
      total_tokens: 12 + words.length,
      cost: 0,
    },
  });
  out += OPENROUTER_DONE_LINE;
  return out;
}

/**
 * A stream carrying `delta.reasoning` chunks before the `delta.content`
 * chunks — the shape a reasoning-capable model emits (reasoning-capture
 * task; verified via Context7 that this plain-string `reasoning` field is a
 * real OpenRouter chat-completions delta shape, distinct from the
 * structured `reasoning_details` array).
 */
export function reasoningThenTextSse(reasoning: string, text: string, model = MODEL): string {
  let out = sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { role: "assistant", reasoning }, finish_reason: null }],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  out += OPENROUTER_DONE_LINE;
  return out;
}

/** A stream that carries zero content chunks and terminates immediately. */
export function emptyStreamSse(): string {
  return OPENROUTER_KEEPALIVE_LINE + OPENROUTER_DONE_LINE;
}

/** A stream that ends mid-generation with no finish_reason and no [DONE]. */
export function truncatedStreamSse(text: string, model = MODEL): string {
  const words = text.split(" ");
  let out = "";
  words.forEach((word, i) => {
    out += sseLine({
      id: GEN_ID,
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: i === 0 ? { role: "assistant", content: word } : { content: ` ${word}` },
          finish_reason: null,
        },
      ],
    });
  });
  return out; // deliberately no finish_reason chunk, no [DONE]
}

/**
 * A stream that starts successfully, streams some content, then carries a
 * top-level `error` alongside finish_reason: "error" — the documented
 * mid-stream failure shape (headers already committed, so no transparent
 * provider failover is possible).
 */
export function midStreamErrorSse(partialText: string, model = MODEL): string {
  const words = partialText.split(" ");
  let out = "";
  words.forEach((word, i) => {
    out += sseLine({
      id: GEN_ID,
      object: "chat.completion.chunk",
      model,
      provider: "OpenAI",
      choices: [
        {
          index: 0,
          delta: i === 0 ? { role: "assistant", content: word } : { content: ` ${word}` },
          finish_reason: null,
        },
      ],
    });
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    created: 1234567890,
    model,
    provider: "OpenAI",
    error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } },
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
  });
  return out; // stream terminates after the error event, no [DONE]
}

/** Non-200 rate-limit response (rejected before any stream begins). */
export function rateLimitedErrorBody() {
  return {
    error: {
      code: 429,
      message: "Rate limit exceeded",
      metadata: { error_type: "rate_limit_exceeded", provider_code: "rate_limited" },
    },
  };
}

/** A well-formed tool_calls delta, split across two chunks (accumulate-by-index). */
export function wellFormedToolCallSse(): string {
  let out = sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "crop_image", arguments: "" } }] },
        finish_reason: null,
      },
    ],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x_percent":10}' } }] }, finish_reason: null },
    ],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  out += OPENROUTER_DONE_LINE;
  return out;
}

/** A tool_calls delta whose accumulated `arguments` never parse as JSON. */
export function malformedToolCallSse(): string {
  let out = sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "crop_image", arguments: '{"x":' } }] },
        finish_reason: null,
      },
    ],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "not valid json" } }] }, finish_reason: null }],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  out += OPENROUTER_DONE_LINE;
  return out;
}

/** Two parallel tool calls (indices 0 and 1) interleaved out of order — merge-by-index stress case. */
export function parallelToolCallsSse(): string {
  let out = sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 1, id: "call_2", type: "function", function: { name: "merge_videos", arguments: "" } },
            { index: 0, id: "call_1", type: "function", function: { name: "crop_image", arguments: "" } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: "{}" } },
            { index: 1, function: { arguments: "{}" } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  out += sseLine({
    id: GEN_ID,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  out += OPENROUTER_DONE_LINE;
  return out;
}
