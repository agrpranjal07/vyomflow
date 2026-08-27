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

/**
 * CORS profile selector threaded through the shared error helpers below.
 * They are called from both the private `/api/v1` surface and the public
 * `/api/public/v1`+`/api/mcp` surface, so each accepts a trailing `profile`
 * (default `"private"`, so all 17 existing call sites are unaffected) —
 * without this, an error response from a public route would carry the
 * FRONTEND_ORIGIN-only CORS headers instead of `*`, breaking CORS on
 * exactly the path a caller is most likely to hit first (a bad request).
 */
type CorsProfile = "private" | "public";

function errorJson(body: unknown, status: number, profile: CorsProfile): Response {
  return profile === "public" ? publicJson(body, status) : json(body, status);
}

/**
 * Second CORS profile for the agent-facing surface (`/api/public/v1/*`,
 * `/api/mcp`) — bearer-only auth (see lib/auth.ts) makes an open origin
 * safe: no ambient cookie can ever authorize a request, so there is nothing
 * for an arbitrary origin to ride. Static `*`, so no `Vary: Origin` is
 * needed, and `Allow-Credentials` is intentionally omitted/never `true`.
 */
export function publicCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization,Content-Type,Idempotency-Key,Last-Event-ID,Mcp-Session-Id,Mcp-Protocol-Version",
    "Access-Control-Expose-Headers":
      "Mcp-Session-Id,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After",
    "Access-Control-Max-Age": "86400",
  };
}

export function publicHandleOptions(): Response {
  return new Response(null, { status: 204, headers: publicCorsHeaders() });
}

function withPublicCors(init?: ResponseInit): ResponseInit {
  return {
    ...init,
    headers: { ...publicCorsHeaders(), ...(init?.headers ?? {}) },
  };
}

export function publicJson(body: unknown, status = 200): Response {
  return Response.json(body, withPublicCors({ status }));
}

export function publicNoContent(): Response {
  return new Response(null, withPublicCors({ status: 204 }));
}

export function unauthorized(profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401, profile);
}

/** Valid credentials, insufficient scope — distinct from `unauthorized`'s missing/invalid credential case. */
export function forbidden(message: string, profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "FORBIDDEN", message } }, 403, profile);
}

/**
 * The single non-leaking 404 shape. A foreign chat, a soft-deleted chat, and
 * a chat id that never existed must all produce this exact response — never
 * a 403 that would confirm existence.
 */
export function notFound(profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "NOT_FOUND", message: "Not found." } }, 404, profile);
}

export function badRequest(message: string, details?: unknown, profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "BAD_REQUEST", message, details } }, 400, profile);
}

/**
 * A request that is well-formed but conflicts with current server state —
 * S2's "second send while a run is active" and "duplicate active run"
 * cases (00-master-spec.md §4 scenario 5, S2-streaming-turn.md). Never a
 * 500: the partial-unique-index violation this wraps is an *expected*
 * outcome of a concurrent-send race, not a server error.
 */
export function conflict(message: string, details?: unknown, profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "CONFLICT", message, details } }, 409, profile);
}

/**
 * Application-level per-user send-rate limiting (S2-streaming-turn.md) —
 * distinct from, and checked before, any OpenRouter-side 429.
 */
export function tooManyRequests(message: string, profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "RATE_LIMITED", message } }, 429, profile);
}

/**
 * Reserved for genuinely unexpected server-side failure — never used for an
 * expected outcome of user input or state (those get 400/404/409/429).
 */
export function serverError(
  message = "Something went wrong. Please try again.",
  profile: CorsProfile = "private",
): Response {
  return errorJson({ error: { code: "SERVER_ERROR", message } }, 500, profile);
}

/**
 * Distinct from `serverError`: the turn was already dispatched and is
 * genuinely running server-side, but the response could not confirm that
 * to the client (e.g. minting the realtime token failed after dispatch
 * succeeded). Never implies "your message failed to send" — the message
 * text must say so explicitly, since retrying the send would duplicate an
 * already-running turn (hardening pass, S2 send route).
 */
export function realtimeUnavailable(message: string, profile: CorsProfile = "private"): Response {
  return errorJson({ error: { code: "REALTIME_UNAVAILABLE", message } }, 503, profile);
}

/** Credit admission failed (00-master-spec.md §4 / assignment §11 "Insufficient Credits"). */
export function insufficientCredits(
  message = "Insufficient credits to start this response.",
  profile: CorsProfile = "private",
): Response {
  return errorJson({ error: { code: "INSUFFICIENT_CREDITS", message } }, 402, profile);
}
