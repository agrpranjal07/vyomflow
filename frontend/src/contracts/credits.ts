// GENERATED — do not edit. Source: efa62177f60585ee7502f39b7ea874721096b9e9:src/contracts/credits.ts
/**
 * S7 — credit balance read contract (00-master-spec.md §4,
 * S7-agent-runtime-implementation-plan.md §6.1). Pure Zod only, same rules
 * as every other file under src/contracts/** — copied verbatim into the
 * frontend by `contracts:sync`.
 *
 * Decimal(12,4) values cross the wire as strings, not numbers — a JS float
 * must never round-trip a money value (implementation plan §12 "Decimal
 * precision across the wire").
 */
import { z } from "zod";
import { CursorQuerySchema, PageSchema } from "@/contracts/common";

export const CreditBalanceDTOSchema = z.object({
  balance: z.string(),
  held: z.string(),
  // available = balance - held, computed at read time (§5.1 — derived,
  // never stored, matching §B.1's admission-check semantics).
  available: z.string(),
});
export type CreditBalanceDTO = z.infer<typeof CreditBalanceDTOSchema>;

// S7 — ledger read contract (assignment §10 "Ledger" row; implementation
// plan §6.1 P1 stretch). Mirrors CreditBalanceDTOSchema's Decimal→string
// rule for `amount`.
export const CreditLedgerEntryDTOSchema = z.object({
  id: z.string(),
  kind: z.enum(["RESERVE", "CAPTURE", "RELEASE", "USAGE"]),
  amount: z.string(),
  createdAt: z.string(),
  runId: z.string().nullable(),
  toolInvocationId: z.string().nullable(),
});
export type CreditLedgerEntryDTO = z.infer<typeof CreditLedgerEntryDTOSchema>;

// `tool` optionally scopes the ledger read to one tool group — same
// `toolKey` values as CreditUsageGroupDTOSchema below ("none" for bare LLM
// usage, otherwise a registered tool name). Powers the /usage "Detailed
// View" tab's tool filter without a second endpoint.
export const ListCreditLedgerQuerySchema = CursorQuerySchema.extend({
  tool: z.string().optional(),
});
export type ListCreditLedgerQuery = z.infer<typeof ListCreditLedgerQuerySchema>;

export const ListCreditLedgerResponseSchema = PageSchema(CreditLedgerEntryDTOSchema);
export type ListCreditLedgerResponse = z.infer<typeof ListCreditLedgerResponseSchema>;

// S7 — /usage "AI Credits Overview" dashboard (implementation plan §5.2/
// §6.2, credits.md "/usage full dashboard — re-verified"). A real
// GROUP BY toolInvocation.name aggregation over CreditLedger CAPTURE/USAGE
// rows only — RESERVE/RELEASE are hold-lifecycle bookkeeping, never counted
// as debited (counting them would double-count the same spend against
// CAPTURE). `toolKey` is "none" for bare LLM usage (no ToolInvocation),
// otherwise the registered tool name.
export const CreditUsageGroupDTOSchema = z.object({
  toolKey: z.string(),
  displayName: z.string(),
  totalDebited: z.string(),
  records: z.number().int().nonnegative(),
  latestUsageAt: z.string().nullable(),
});
export type CreditUsageGroupDTO = z.infer<typeof CreditUsageGroupDTOSchema>;

export const CreditUsageSummaryDTOSchema = z.object({
  groups: z.array(CreditUsageGroupDTOSchema),
  totalDebitedAll: z.string(),
  recordsAll: z.number().int().nonnegative(),
  categoriesCount: z.number().int().nonnegative(),
  // Real min/max createdAt across included rows — null when there is no
  // history yet, never a fabricated "current period" range.
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
});
export type CreditUsageSummaryDTO = z.infer<typeof CreditUsageSummaryDTOSchema>;

// S7 — "Usage details" modal drill-down (credits.md "`/usage` — Action/
// 'View details' drill-down gap"). Every CreditLedger row sharing one
// record's runId — the full RESERVE/CAPTURE/RELEASE/USAGE lifecycle for
// that run, not just the CAPTURE/USAGE subset the totals use (deliberate,
// per the evidence file). `chatId` is a real identifier (AgentRun.chatId,
// via the runId → AgentRun join) — ownership already proven transitively
// by the caller-scoped ledger read that found this runId, never a second
// unscoped lookup.
// Adds `toolName` (the raw tool registry key, e.g. "crop_image") over the
// base ledger entry — resolved via the row's toolInvocation relation so
// the frontend can label each step with the same tool-display-name mapping
// used elsewhere, without a second lookup.
export const CreditRunStepEntryDTOSchema = CreditLedgerEntryDTOSchema.extend({
  toolName: z.string().nullable(),
});
export type CreditRunStepEntryDTO = z.infer<typeof CreditRunStepEntryDTOSchema>;

export const CreditRunStepsDTOSchema = z.object({
  chatId: z.string().nullable(),
  items: z.array(CreditRunStepEntryDTOSchema),
});
export type CreditRunStepsDTO = z.infer<typeof CreditRunStepsDTOSchema>;

// S7 — netted usage-entry list for `GET /api/v1/me/credits/usage-entries`
// (credits.md "`/usage` — Action/'View details' drill-down gap", netted-
// rows fold-in). One row per run within the requested tool bucket — `amount`
// is that run's CAPTURE/USAGE total (never RESERVE/RELEASE), `timestamp` is
// the latest of those rows' createdAt. This is what the Detailed View
// tab's record table renders; the full raw per-run lifecycle (including
// RESERVE/RELEASE) stays available separately via
// `GET /api/v1/me/credits/ledger/run/[runId]` once a row is opened.
export const CreditUsageEntryDTOSchema = z.object({
  runId: z.string(),
  amount: z.string(),
  timestamp: z.string(),
});
export type CreditUsageEntryDTO = z.infer<typeof CreditUsageEntryDTOSchema>;

export const ListCreditUsageEntriesQuerySchema = z.object({
  tool: z.string(),
});
export type ListCreditUsageEntriesQuery = z.infer<typeof ListCreditUsageEntriesQuerySchema>;

export const ListCreditUsageEntriesResponseSchema = z.object({
  entries: z.array(CreditUsageEntryDTOSchema),
});
export type ListCreditUsageEntriesResponse = z.infer<typeof ListCreditUsageEntriesResponseSchema>;
