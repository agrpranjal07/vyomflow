import { authenticateWithIdentity } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { CreateApiKeyRequestSchema, createApiKey } from "@/services/api-keys";

export function OPTIONS() {
  return handleOptions();
}

/**
 * Mints a self-serve public-API key on the caller's behalf, scoped to
 * `PUBLIC_API_DEFAULT_SCOPES` (lib/api-key-scopes.ts) via the Clerk Backend
 * API — replaces the broken flow where Clerk's own `<APIKeys/>` widget
 * (Frontend API) minted permanently zero-scope keys. Session-token only —
 * this is an account setting, not agent-facing, so it lives under the
 * internal `/api/v1` surface rather than `/api/public/v1` (same rationale
 * as `/api/v1/webhooks`).
 */
export async function POST(req: Request) {
  const auth = await authenticateWithIdentity(req);
  if (auth instanceof Response) return auth;

  const parsed = CreateApiKeyRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request body.", parsed.error.flatten());

  const apiKey = await createApiKey(auth.identity.clerkUserId, parsed.data);
  return json(apiKey, 201);
}
