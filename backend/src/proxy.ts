// Next.js 16 renamed `middleware.ts` to `proxy.ts` (same behavior, new file
// name — see frontend/src/proxy.ts's own note, and
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
//
// Every route handler already attaches its own CORS headers per-response
// via src/lib/http.ts (corsHeaders/publicCorsHeaders). That is fine for a
// handled response, but a response Next generates itself — an uncaught
// throw turned into a 500 — carries none of those headers, and the browser
// then reports a misleading "CORS policy" error that hides the real
// failure (see .claude/state/open-questions.md, 2026-08-29 entry: a
// legacy-shape Waitpoint row threw a ZodError inside
// AgentRunDTOSchema.parse with no try/catch, and the resulting bare 500
// surfaced as a CORS block). This proxy is a safety net stamping the
// correct CORS profile onto every /api/* response, handled or not — it
// does not replace the per-response helpers, which still run first and
// still own the actual header values for their own profile.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { corsHeaders, publicCorsHeaders } from "@/lib/http";

// Bearer-only surfaces (see http.ts's own doc comment on publicCorsHeaders)
// get the open "*" profile; everything else under /api/* is the
// cookie/FRONTEND_ORIGIN-scoped private profile.
const PUBLIC_PREFIXES = ["/api/public/v1/", "/api/mcp"];

export function proxy(request: NextRequest) {
  const isPublic = PUBLIC_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix));
  const headers = isPublic ? publicCorsHeaders() : corsHeaders();
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value as string);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
