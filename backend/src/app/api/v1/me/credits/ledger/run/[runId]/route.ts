import { authenticate } from "@/lib/auth";
import { handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditRunStepsDTOSchema } from "@/contracts/credits";
import { listCreditLedgerByRun } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

/**
 * S7 — "Usage details" modal step breakdown (credits.md "`/usage` — Action/
 * 'View details' drill-down gap"). Caller-scoped by `userId` on the ledger
 * query itself (listCreditLedgerByRun) — a runId belonging to another user
 * simply returns an empty `items`/`null` chatId, not a 404/403 leak of
 * whether that runId exists at all.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { runId } = await params;
  const steps = await listCreditLedgerByRun(auth.userId, runId);
  log.info("credits.ledger_run_read", { userId: auth.userId, runId });
  return json(CreditRunStepsDTOSchema.parse(steps));
}
