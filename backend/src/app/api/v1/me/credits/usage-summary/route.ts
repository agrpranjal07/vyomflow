import { authenticate } from "@/lib/auth";
import { handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditUsageSummaryDTOSchema } from "@/contracts/credits";
import { getCreditUsageSummary } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

// Caller's own usage summary only — no userId param accepted, same posture
// as GET /api/v1/me/credits and its /ledger sibling.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const summary = await getCreditUsageSummary(auth.userId);
  log.info("credits.usage_summary_read", { userId: auth.userId });
  return json(CreditUsageSummaryDTOSchema.parse(summary));
}
