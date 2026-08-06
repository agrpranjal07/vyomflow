import { authenticate } from "@/lib/auth";
import { handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditBalanceDTOSchema } from "@/contracts/credits";
import { getCreditSummary } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

// Caller's own balance only — no userId param accepted, so there is no
// cross-user read surface (implementation plan §6.1).
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const summary = await getCreditSummary(auth.userId);
  log.info("credits.read", { userId: auth.userId });
  return json(CreditBalanceDTOSchema.parse(summary));
}
