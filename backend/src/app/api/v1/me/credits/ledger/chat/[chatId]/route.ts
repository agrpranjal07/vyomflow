import { authenticate } from "@/lib/auth";
import { handleOptions, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { CreditChatRunsDTOSchema } from "@/contracts/credits";
import { listCreditLedgerByChat } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

/**
 * S7 — "VyomFlow" aggregate row's Details drill-down (2026-08-29 UX fix),
 * mirroring ledger/run/[runId]'s own stance: caller-scoped by `userId` on
 * the ledger query itself (listCreditLedgerByChat) — a chatId belonging to
 * another user simply returns an empty `items`/`null` chatTitle, never a
 * 404/403 leak of whether that chatId exists at all.
 */
export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  const runs = await listCreditLedgerByChat(auth.userId, chatId);
  log.info("credits.ledger_chat_read", { userId: auth.userId, chatId });
  return json(CreditChatRunsDTOSchema.parse(runs));
}
