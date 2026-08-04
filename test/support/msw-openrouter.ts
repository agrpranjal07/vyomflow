/**
 * Shared MSW server + handler factory for mocking OpenRouter's
 * chat-completions endpoint. Used by every S2 test that exercises
 * src/server/openrouter/client.ts or src/server/agent/loop.ts — no live
 * OpenRouter calls in any automated suite (testing-policy.md,
 * S2-streaming-turn.md §10 budget policy).
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Responds with a raw SSE body (text/event-stream) for the given fixture. */
export function openRouterStreamHandler(sseBody: string, status = 200) {
  return http.post(OPENROUTER_COMPLETIONS_URL, () => {
    return new HttpResponse(sseBody, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
}

/** Responds with a non-200 JSON error envelope (rejected before any stream begins). */
export function openRouterErrorHandler(status: number, body: unknown) {
  return http.post(OPENROUTER_COMPLETIONS_URL, () => HttpResponse.json(body, { status }));
}

/**
 * Responds with one SSE body per request, in order — the Nth call to
 * chat/completions gets `sseBodies[N]` (clamped to the last entry once
 * exhausted). Used for multi-turn tool-loop tests where each round of the
 * loop re-enters OpenRouter with a different accumulated message history
 * and must see a different scripted response.
 */
export function openRouterSequentialStreamHandler(sseBodies: string[]) {
  let call = 0;
  return http.post(OPENROUTER_COMPLETIONS_URL, () => {
    const body = sseBodies[Math.min(call, sseBodies.length - 1)];
    call++;
    return new HttpResponse(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
}

/**
 * Like `openRouterStreamHandler`, but also captures the parsed request body
 * of every call into `captured` (in call order) — for tests that need to
 * assert on the real wire shape sent to OpenRouter (e.g. a multimodal
 * `content` array with an `image_url` part), not just the response.
 */
export function openRouterCapturingStreamHandler(sseBody: string, captured: unknown[], status = 200) {
  return http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
    captured.push(await request.json());
    return new HttpResponse(sseBody, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
}

export const openRouterServer = setupServer();
