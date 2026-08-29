import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditUsageSummaryDTOSchema, UsagePeriodQuerySchema } from "@/contracts/credits";
import { getCreditUsageSummary } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

// Caller's own usage summary only — no userId param accepted, same posture
// as GET /api/v1/me/credits and its /ledger sibling. Optional `?period=`
// (2026-08-29 — the /usage page's period filter) defaults to "all", the
// same unfiltered history this endpoint always returned before the filter
// existed.
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = UsagePeriodQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const summary = await getCreditUsageSummary(auth.userId, parsed.data.period);
  log.info("credits.usage_summary_read", { userId: auth.userId, period: parsed.data.period });
  return json(CreditUsageSummaryDTOSchema.parse(summary));
}
