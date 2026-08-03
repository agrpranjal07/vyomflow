/**
 * Shared Route Handler response helpers. Every /api/v1/* handler goes
 * through these so status/shape stays uniform — in particular the
 * non-leaking 404 (owned-not-found vs. never-existed must be byte-identical,
 * see S1-chat-surface.md).
 */

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function withCors(init?: ResponseInit): ResponseInit {
  return {
    ...init,
    headers: { ...corsHeaders(), ...(init?.headers ?? {}) },
  };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, withCors({ status }));
}

export function noContent(): Response {
  return new Response(null, withCors({ status: 204 }));
}

export function unauthorized(): Response {
  return json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
}

/**
 * The single non-leaking 404 shape. A foreign chat, a soft-deleted chat, and
 * a chat id that never existed must all produce this exact response — never
 * a 403 that would confirm existence.
 */
export function notFound(): Response {
  return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
}

export function badRequest(message: string, details?: unknown): Response {
  return json({ error: { code: "BAD_REQUEST", message, details } }, 400);
}

/**
 * A request that is well-formed but conflicts with current server state —
 * S2's "second send while a run is active" and "duplicate active run"
 * cases (00-master-spec.md §4 scenario 5, S2-streaming-turn.md). Never a
 * 500: the partial-unique-index violation this wraps is an *expected*
 * outcome of a concurrent-send race, not a server error.
 */
export function conflict(message: string, details?: unknown): Response {
  return json({ error: { code: "CONFLICT", message, details } }, 409);
}

/**
 * Application-level per-user send-rate limiting (S2-streaming-turn.md) —
 * distinct from, and checked before, any OpenRouter-side 429.
 */
export function tooManyRequests(message: string): Response {
  return json({ error: { code: "RATE_LIMITED", message } }, 429);
}

/**
 * Reserved for genuinely unexpected server-side failure — never used for an
 * expected outcome of user input or state (those get 400/404/409/429).
 */
export function serverError(message = "Something went wrong. Please try again."): Response {
  return json({ error: { code: "SERVER_ERROR", message } }, 500);
}

/**
 * Distinct from `serverError`: the turn was already dispatched and is
 * genuinely running server-side, but the response could not confirm that
 * to the client (e.g. minting the realtime token failed after dispatch
 * succeeded). Never implies "your message failed to send" — the message
 * text must say so explicitly, since retrying the send would duplicate an
 * already-running turn (hardening pass, S2 send route).
 */
export function realtimeUnavailable(message: string): Response {
  return json({ error: { code: "REALTIME_UNAVAILABLE", message } }, 503);
}

/** Credit admission failed (00-master-spec.md §4 / assignment §11 "Insufficient Credits"). */
export function insufficientCredits(message = "Insufficient credits to start this response."): Response {
  return json({ error: { code: "INSUFFICIENT_CREDITS", message } }, 402);
}
