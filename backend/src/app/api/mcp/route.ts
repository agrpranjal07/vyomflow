/**
 * S8 Phase 5 — MCP streamable-HTTP transport entry point. Stateless
 * `createMcpHandler(buildVyomFlowServer)`: no session map, no resumability —
 * a module-scope session store would not survive this route's serverless
 * instances (the same reasoning `src/server/dispatch.ts` documents for
 * every other Trigger.dev call site in this codebase).
 *
 * Auth: reuses `authenticateWithIdentity` (Phase 2) with the `"public"` CORS
 * profile, same as `/api/public/v1/*`. An MCP client is an agent-facing
 * surface, never a browser one, so a `session_token` caller is rejected
 * outright here — session tokens are for the first-party web app only; an
 * MCP client must hold a scoped API key. This is a deliberate policy choice,
 * not implied by the installed SDK's own auth model, which treats `AuthInfo`
 * as a pass-through the caller may derive however it likes.
 */
import { authenticateWithIdentity } from "@/lib/auth";
import { publicHandleOptions, publicCorsHeaders, forbidden } from "@/lib/http";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { buildVyomFlowServer } from "@/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const handler = createMcpHandler(buildVyomFlowServer);

/** `handler.fetch` knows nothing of our CORS policy — every response it produces (including its own error paths) needs the public profile's headers merged in, not just the OPTIONS preflight. */
function withPublicCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(publicCorsHeaders())) headers.set(key, value as string);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function serve(req: Request): Promise<Response> {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;

  if (auth.identity.tokenType !== "api_key") {
    return forbidden(
      "The MCP endpoint requires an API key (Authorization: Bearer <api key>). Session tokens are for the first-party web app only.",
      "public",
    );
  }

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authInfo: AuthInfo = {
    token,
    clientId: auth.identity.clerkUserId,
    scopes: auth.identity.scopes,
    extra: { appUserId: auth.userId, clerkUserId: auth.identity.clerkUserId },
  };

  return withPublicCors(await handler.fetch(req, { authInfo }));
}

export { serve as GET, serve as POST, serve as DELETE };

export function OPTIONS() {
  return publicHandleOptions();
}
