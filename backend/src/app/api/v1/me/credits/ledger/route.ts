import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { ListCreditLedgerQuerySchema, ListCreditLedgerResponseSchema } from "@/contracts/credits";
import { listCreditLedger } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

// Caller's own ledger only — no userId param accepted, same posture as
// GET /api/v1/me/credits (implementation plan §6.1).
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = ListCreditLedgerQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const page = await listCreditLedger(auth.userId, parsed.data);
  log.info("credits.ledger_read", { userId: auth.userId });
  return json(ListCreditLedgerResponseSchema.parse(page));
}
