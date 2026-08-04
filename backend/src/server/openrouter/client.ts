/**
 * OpenRouter chat-completions streaming request. Deliberately does NOT send
 * `stream_options.include_usage` — verified deprecated and a no-op; usage
 * is returned unconditionally in the final SSE message
 * (openrouter.ai/docs/use-cases/usage-accounting, S2 implementation plan §E).
 *
 * S3: widened to carry `tools` (OpenAI-format specs from the tool registry)
 * and the `tool_calls`/`tool_call_id` message fields a multi-turn
 * tool-calling conversation requires on the wire.
 */
import { OPENROUTER_REQUEST_TIMEOUT_MS } from "@/lib/config";

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// S4: a user message with image attachments needs an `image_url` part
// alongside its text so the model actually sees the image (previously only
// a text line listing the URL was ever sent — see conversation.ts).
export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenRouterContentPart[] | null;
  /** Set on an assistant message that invoked one or more tools. */
  tool_calls?: OpenRouterToolCall[];
  /** Set on a "tool" role message — links the result back to its call. */
  tool_call_id?: string;
}

export interface OpenRouterStreamRequest {
  model: string;
  messages: OpenRouterMessage[];
  /** OpenAI-format tool specs from the registry (server/tools/registry.ts). Omitted entirely when there are none. */
  tools?: unknown[];
  signal?: AbortSignal;
}

/**
 * Resets on every chunk and aborts `controller` (erroring the stream) after
 * `idleMs` with no data — a legitimate long-running completion that keeps
 * emitting chunks must never be cut off by a single whole-request deadline
 * (that was this file's previous bug: `AbortSignal.timeout` starts counting
 * at request start and is never cleared, so it fires mid-stream on any
 * response taking longer than `OPENROUTER_REQUEST_TIMEOUT_MS` in total).
 */
function idleTimeoutTransform(idleMs: number, controller: AbortController): TransformStream<Uint8Array, Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onIdle = (tsController: TransformStreamDefaultController<Uint8Array>) => {
    controller.abort();
    tsController.error(new Error("OpenRouter stream idle timeout."));
  };
  // `cancel` runs when the consumer cancels the readable side (e.g. Stop) —
  // it's not in lib.dom's Transformer type but is invoked at runtime
  // (Node's stream/web TransformStream), so it's typed explicitly here.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel?(): void } = {
    start(tsController) {
      timer = setTimeout(() => onIdle(tsController), idleMs);
    },
    transform(chunk, tsController) {
      clearTimeout(timer);
      timer = setTimeout(() => onIdle(tsController), idleMs);
      tsController.enqueue(chunk);
    },
    flush() {
      clearTimeout(timer);
    },
    cancel() {
      clearTimeout(timer);
    },
  };
  return new TransformStream(transformer);
}

/**
 * Sends the request and returns the raw fetch Response — callers decide how
 * to handle a non-200 status vs. stream the 200 body. Kept a thin wrapper
 * so tests can mock `fetch` (via MSW) without reimplementing this module.
 */
export async function requestOpenRouterCompletion(req: OpenRouterStreamRequest): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  // Own AbortController (not AbortSignal.timeout) so the connect-phase
  // deadline can actually be cleared once headers arrive, instead of
  // continuing to count down through the whole streaming response.
  const controller = new AbortController();
  const connectTimer = setTimeout(
    () => controller.abort(new Error("OpenRouter connect timeout.")),
    OPENROUTER_REQUEST_TIMEOUT_MS,
  );
  const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
      }),
      signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.body) return response;

  // From here on, the deadline is an idle-gap timeout during SSE
  // consumption, not a single whole-stream deadline.
  const idleBody = response.body.pipeThrough(idleTimeoutTransform(OPENROUTER_REQUEST_TIMEOUT_MS, controller));
  return new Response(idleBody, { status: response.status, statusText: response.statusText, headers: response.headers });
}
