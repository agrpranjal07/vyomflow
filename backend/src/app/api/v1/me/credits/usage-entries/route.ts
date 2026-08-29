import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { ListCreditUsageEntriesQuerySchema, ListCreditUsageEntriesResponseSchema } from "@/contracts/credits";
import { listUsageEntries } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

/**
 * S7 — netted usage-entry list backing the /usage Detailed View tab's
 * record table (credits.md "`/usage` — Action/'View details' drill-down
 * gap", netted-rows fold-in). Caller-scoped by `userId`, same posture as
 * this file's `/ledger` and `/usage-summary` siblings. `tool` is required
 * (not optional) — this endpoint only ever renders one tool bucket at a
 * time, unlike `/ledger`'s general-purpose optional filter.
 */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = ListCreditUsageEntriesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const entries = await listUsageEntries(auth.userId, parsed.data.tool, parsed.data.period);
  log.info("credits.usage_entries_read", { userId: auth.userId, tool: parsed.data.tool, period: parsed.data.period });
  return json(ListCreditUsageEntriesResponseSchema.parse({ entries }));
}
