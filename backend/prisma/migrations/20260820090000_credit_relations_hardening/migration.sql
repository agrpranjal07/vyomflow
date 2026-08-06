-- Hardening pass (2026-08-20): CreditHold had no FK/relation to User at
-- all — referential integrity was app-level only. CreditLedger's FK to
-- User was ON DELETE CASCADE, which would silently destroy the append-only
-- audit trail if a User row were ever deleted. Forward-fixing via a new
-- migration rather than editing the already-applied
-- 20260819125216_s2_streaming_turn (real rows now exist in this
-- environment; rewriting an applied migration's SQL would desync its
-- tracked checksum against every database that already ran it).

-- AddForeignKey
-- Ephemeral working state tied 1:1 to a run — cascading it away with its
-- owning user is correct and matches every other user-owned-ephemeral-row
-- FK in this schema (chats, messages).
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey / AddForeignKey
-- Append-only audit trail — must never be silently cascade-deleted with
-- its user. RESTRICT means a user with ledger history cannot be
-- hard-deleted without the audit trail being handled explicitly first,
-- instead of the history vanishing invisibly.
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_userId_fkey";
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
