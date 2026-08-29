import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { ListCreditUsageChatEntriesQuerySchema, ListCreditUsageChatEntriesResponseSchema } from "@/contracts/credits";
import { listUsageEntriesByChat } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

/**
 * S7 — per-chat netted usage backing the /usage Detailed View tab's
 * "VyomFlow" aggregate group (2026-08-29 UX fix). Sibling of
 * `/usage-entries`, but netted by chat instead of by (tool, run) — the
 * aggregate group has no single tool bucket to scope to, so it gets its
 * own endpoint rather than overloading `?tool=` with a sentinel value.
 * Optional `?period=` (2026-08-29 — the /usage page's period filter)
 * defaults to "all".
 */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = ListCreditUsageChatEntriesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const entries = await listUsageEntriesByChat(auth.userId, parsed.data.period);
  log.info("credits.usage_entries_by_chat_read", { userId: auth.userId, period: parsed.data.period });
  return json(ListCreditUsageChatEntriesResponseSchema.parse({ entries }));
}
