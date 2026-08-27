import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { SetWebhookEndpointRequestSchema, WebhookEndpointDTOSchema } from "@/contracts/webhooks";
import { setWebhookEndpoint } from "@/services/webhooks";

export function OPTIONS() {
  return handleOptions();
}

/**
 * Sets (or rotates) the caller's own outbound webhook endpoint (S8 Phase 6
 * — minimal scope: one row per user, no per-event subscriptions, no UI).
 * Session-token only — this is an account setting, not agent-facing, so it
 * lives under the internal `/api/v1` surface rather than `/api/public/v1`.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsed = SetWebhookEndpointRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request body.", parsed.error.flatten());

  const endpoint = await setWebhookEndpoint(auth.userId, parsed.data);
  return json(WebhookEndpointDTOSchema.parse(endpoint), 200);
}
