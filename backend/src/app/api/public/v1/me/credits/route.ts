import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { publicHandleOptions, publicJson } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditBalanceDTOSchema } from "@/contracts/credits";
import { getCreditSummary } from "@/services/credits";

export function OPTIONS() {
  return publicHandleOptions();
}

// Caller's own balance only — no userId param accepted (mirrors /api/v1/me/credits).
export async function GET(req: Request) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "credits:read");
  if (scopeErr) return scopeErr;

  const summary = await getCreditSummary(auth.userId);
  log.info("credits.read", { userId: auth.userId, source: "public_api" });
  return publicJson(CreditBalanceDTOSchema.parse(summary));
}
