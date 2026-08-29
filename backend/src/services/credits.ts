/**
 * Credit settlement — CreditHold/CreditLedger machinery (00-master-spec.md
 * §4), scoped to the LLM-only case for S2 (no `capture` yet — nothing
 * billable happens without tools). Every mutation runs inside the caller's
 * transaction (or opens its own single-statement one) and every ledger
 * insert carries a unique idempotencyKey, so a retried caller never double
 * -reserves/-releases/-records.
 */
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";
import { clampLimit, decodeCursor, encodeCursor } from "@/lib/cursor";
import { AGGREGATE_TOOL_KEY, type ListCreditLedgerQuery, type UsagePeriod } from "@/contracts/credits";
import { CROP_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME, MERGE_VIDEOS_TOOL_NAME } from "@/contracts/tools";

// toolKey used for bare LLM usage rows (no ToolInvocation) — matches
// listCreditLedger's own `tool` query-param sentinel below.
const NO_TOOL_KEY = "none";

// /usage page's period filter (2026-08-29) — real wall-clock cutoffs off
// the current request time, never a fabricated "billing period" concept
// this project has no such thing for. `null` means "all" — no lower bound.
function periodCutoff(period: UsagePeriod): Date | null {
  if (period === "all") return null;
  const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export class InsufficientCreditsError extends Error {
  constructor() {
    super("Insufficient credits.");
    this.name = "InsufficientCreditsError";
  }
}

type Tx = Prisma.TransactionClient;

/**
 * Atomically reserves `amount` against the user's balance (one conditional
 * UPDATE — 00-master-spec.md §4's TOCTOU-safe admission check, not a
 * read-then-write), then records the OPEN CreditHold and RESERVE ledger row
 * in the same transaction. Idempotency key `reserve:{runId}` — a retried
 * call with the same runId is a no-op via the ledger's unique constraint,
 * caught and treated as "already reserved" rather than a double debit.
 *
 * Throws InsufficientCreditsError if the conditional UPDATE affects zero
 * rows (assignment §11 "Insufficient Credits: Block execution, show clear
 * message").
 */
export async function reserveHold(
  tx: Tx,
  params: { runId: string; userId: string; amount: number; traceId?: string },
): Promise<void> {
  const { runId, userId, amount, traceId } = params;

  // CreditHold.runId is unique — create it first as the idempotency guard,
  // before touching the user's balance. A retried call for the same runId
  // loses the unique-constraint race here and returns as a no-op, instead
  // of first mutating creditHeld and only then discovering the duplicate
  // (the previous ordering did real balance work before ever checking).
  try {
    await tx.creditHold.create({
      data: { runId, userId, amount, status: "OPEN" },
    });
  } catch (error) {
    if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }

  const updated: number = await tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "users"
      SET "creditHeld" = "creditHeld" + ${amount}
      WHERE id = ${userId} AND "creditBalance" - "creditHeld" >= ${amount}
    `,
  );
  if (updated === 0) {
    throw new InsufficientCreditsError();
  }

  await tx.creditLedger.create({
    data: {
      userId,
      runId,
      kind: "RESERVE",
      amount,
      idempotencyKey: `reserve:${runId}`,
    },
  });
  log.info("credits.reserved", { runId, traceId, amount });
}

/**
 * Grows an OPEN hold before dispatching a tool (D2 — 00-master-spec.md §4
 * amendment, 2026-08-20). Same TOCTOU-safe conditional UPDATE as
 * `reserveHold`, applied to the delta only. Idempotency key
 * `reserve:{runId}:{toolInvocationId}` — a retried top-up for the same tool
 * invocation is a no-op via the ledger's unique constraint.
 *
 * Throws InsufficientCreditsError if the conditional UPDATE affects zero
 * rows — callers must follow the §11 mid-turn-exhaustion path: settle
 * already-completed tool work, release the remainder, and terminate with a
 * clear reason, never silently skip the tool.
 *
 * Also throws InsufficientCreditsError (reused rather than adding a new
 * error type — callers already terminate the run on it) if the hold is no
 * longer OPEN by the time it's locked below: a cancelled/already-finalized
 * run's hold must never be topped up, or the increment would never be
 * released and would leak credit forever.
 */
export async function reserveAdditional(
  tx: Tx,
  params: { runId: string; userId: string; toolInvocationId: string; amount: number; traceId?: string },
): Promise<void> {
  const { runId, userId, toolInvocationId, amount, traceId } = params;

  // Lock the hold row first (mirrors releaseHold's FOR UPDATE) and verify
  // it's still OPEN before growing it — without this, a hold already
  // RELEASED/CAPTURED by a concurrent finalize could still be incremented
  // here and the increment would never be released.
  const locked = await tx.$queryRaw<Array<{ status: string }>>(
    PrismaRuntime.sql`SELECT "status" FROM "credit_holds" WHERE "runId" = ${runId} FOR UPDATE`,
  );
  if (locked.length === 0 || locked[0].status !== "OPEN") {
    throw new InsufficientCreditsError();
  }

  const updated: number = await tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "users"
      SET "creditHeld" = "creditHeld" + ${amount}
      WHERE id = ${userId} AND "creditBalance" - "creditHeld" >= ${amount}
    `,
  );
  if (updated === 0) {
    throw new InsufficientCreditsError();
  }

  await tx.creditHold.update({
    where: { runId },
    data: { amount: { increment: amount } },
  });
  await tx.creditLedger.create({
    data: {
      userId,
      runId,
      toolInvocationId,
      kind: "RESERVE",
      amount,
      idempotencyKey: `reserve:${runId}:${toolInvocationId}`,
    },
  });
  log.info("credits.reserved_additional", { runId, traceId, toolInvocationId, amount });
}

/**
 * Settles a completed (or reported-billable-failed) tool invocation exactly
 * once (D2 — capture is always at the tool's *reported* creditUsed, never the
 * pre-dispatch estimate, per 00-master-spec.md §4 scenario 1). Idempotency
 * key `capture:{toolInvocationId}` — a retried capture for the same
 * invocation is a no-op via the ledger's unique constraint, caught and
 * ignored so no second debit occurs.
 *
 * Decrements `creditBalance` and `creditHeld` together (capture converts
 * held credit into spent credit — the hold's own `amount` is untouched so
 * `releaseHold` can still compute the correct remainder) and increments the
 * hold's `capturedAmount` running total.
 *
 * Not composable into a larger caller-owned transaction beyond `tx` itself:
 * the P2002 catch below only works because this function's own duplicate
 * insert is the sole statement that can fail in `tx` — Postgres aborts the
 * *entire* transaction on a unique violation, so if a caller ever bundled
 * this call alongside other writes in one shared `tx`, that P2002 would
 * poison all of them, not just this insert. Its only caller today
 * (src/trigger/tool.ts) already gives it a dedicated transaction, so no
 * behavior change is needed — just don't reuse this inside a bigger `tx`.
 */
export async function captureForTool(
  tx: Tx,
  params: { runId: string; userId: string; toolInvocationId: string; amount: number },
): Promise<void> {
  const { runId, userId, toolInvocationId, amount } = params;

  // S6 fix (.claude/specs/S6-reliability-implementation-plan.md §7.4):
  // mirror reserveAdditional's own FOR UPDATE guard. Without this, a hold
  // already RELEASED/CAPTURED-terminal by a concurrent finalize (e.g. the
  // sweep releasing a stale hold on a run that independently completes and
  // captures at the same moment) could still be captured against here,
  // double-debiting the user's creditBalance for one tool invocation.
  const locked = await tx.$queryRaw<Array<{ status: string }>>(
    PrismaRuntime.sql`SELECT "status" FROM "credit_holds" WHERE "runId" = ${runId} FOR UPDATE`,
  );
  if (locked.length === 0 || locked[0].status !== "OPEN") {
    log.warn("credits.capture_skipped_non_open_hold", { runId, toolInvocationId, holdStatus: locked[0]?.status });
    return;
  }

  // Ledger insert first, guarded by its own unique idempotencyKey — a
  // concurrent duplicate capture for the same tool invocation loses the
  // unique-constraint race and is treated as an already-captured no-op,
  // rather than the previous separate findUnique-then-create sequence
  // (a TOCTOU gap under concurrency: two callers could both pass the
  // findUnique check before either committed its create).
  try {
    await tx.creditLedger.create({
      data: {
        userId,
        runId,
        toolInvocationId,
        kind: "CAPTURE",
        amount,
        idempotencyKey: `capture:${toolInvocationId}`,
      },
    });
  } catch (error) {
    if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }

  // A tool's reported creditUsed can in principle exceed what was actually
  // reserved (an underestimated pre-dispatch hold) — clamp so a capture
  // can never drive creditBalance/creditHeld negative; the ledger row above
  // still records the true reported amount for audit purposes.
  await tx.$executeRaw(
    PrismaRuntime.sql`
      UPDATE "users"
      SET "creditBalance" = GREATEST("creditBalance" - ${amount}, 0),
          "creditHeld" = GREATEST("creditHeld" - ${amount}, 0)
      WHERE id = ${userId}
    `,
  );
  await tx.creditHold.update({
    where: { runId },
    data: { capturedAmount: { increment: amount } },
  });
}

/**
 * Releases whatever remains of a run's hold — `amount - capturedAmount`, so
 * a run with one or more tool captures still releases only the untouched
 * remainder (D2). S2's LLM-only path always had `capturedAmount` 0, so this
 * releases the full amount there too — additive, not a behavior change.
 * Idempotent: a hold already RELEASED/CAPTURED is left untouched and no
 * second RELEASE ledger row is written, so cancel-vs-complete races and a
 * retried finalize both settle to exactly one release (S2 implementation
 * plan §H). Final status is CAPTURED when any capture occurred, else
 * RELEASED, so the hold's own status records whether the run ever billed
 * anything without re-deriving it from the ledger.
 */
export async function releaseHold(tx: Tx, runId: string, traceId?: string): Promise<void> {
  // Lock the row first (`FOR UPDATE`) so a concurrent captureForTool
  // transaction against the same hold can't commit a fresh capturedAmount
  // between this read and the writes below — without the lock, releaseHold
  // could compute its remainder from a stale capturedAmount and release
  // credit a just-committed capture had already spent. The follow-up typed
  // read goes through the normal Prisma client (correct Decimal typing);
  // the lock, once taken, holds for the rest of this transaction.
  const locked = await tx.$queryRaw<Array<{ id: string }>>(
    PrismaRuntime.sql`SELECT "id" FROM "credit_holds" WHERE "runId" = ${runId} FOR UPDATE`,
  );
  if (locked.length === 0) return;
  const hold = await tx.creditHold.findUniqueOrThrow({ where: { runId } });
  if (hold.status !== "OPEN") return;

  // Clamp to zero — a capturedAmount that (defensively) meets or exceeds
  // amount must never produce a negative release.
  const remainder = PrismaRuntime.Decimal.max(0, hold.amount.minus(hold.capturedAmount));
  if (remainder.greaterThan(0)) {
    await tx.$executeRaw(
      PrismaRuntime.sql`
        UPDATE "users"
        SET "creditHeld" = "creditHeld" - ${remainder}
        WHERE id = ${hold.userId}
      `,
    );
  }
  await tx.creditHold.update({
    where: { runId },
    data: {
      status: hold.capturedAmount.greaterThan(0) ? "CAPTURED" : "RELEASED",
      resolvedAt: new Date(),
    },
  });
  await tx.creditLedger.create({
    data: {
      userId: hold.userId,
      runId,
      kind: "RELEASE",
      amount: remainder,
      idempotencyKey: `release:${runId}`,
    },
  });
  log.info("credits.released", {
    runId,
    traceId,
    amount: remainder.toFixed(4),
    captured: hold.capturedAmount.toFixed(4),
  });
}

/**
 * Records OpenRouter usage at zero app-credit cost (00-master-spec.md §4 —
 * "record only, never debited"). `turnIndex` disambiguates multiple
 * OpenRouter calls within one turn once S3's tool loop can re-enter the
 * model; S2 always calls this with turnIndex 0 for its single completion.
 */
export async function recordUsage(
  tx: Tx,
  params: {
    runId: string;
    userId: string;
    turnIndex: number;
    metadata: Prisma.InputJsonValue;
    traceId?: string;
  },
): Promise<void> {
  const { runId, userId, turnIndex, metadata, traceId } = params;
  try {
    await tx.creditLedger.create({
      data: {
        userId,
        runId,
        kind: "USAGE",
        amount: 0,
        idempotencyKey: `usage:${runId}:${turnIndex}`,
        metadata,
      },
    });
  } catch (error) {
    // A Trigger.dev retry re-recording the same round is a no-op, not a
    // reason to fail the whole turn — usage rows carry no balance mutation
    // to unwind either way.
    if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
  log.info("credits.usage_recorded", { runId, traceId, turnIndex });
}

/** Convenience wrapper for callers outside an existing transaction. */
export async function releaseHoldStandalone(runId: string): Promise<void> {
  await prisma.$transaction((tx) => releaseHold(tx, runId));
}

/**
 * S7 — read-only balance summary for `GET /api/v1/me/credits`
 * (implementation plan §5.1/§6.1). `available` is computed at read time
 * from `balance - held`, exactly mirroring the admission check's own
 * `creditBalance - creditHeld` — never a stored/cached third value.
 */
export async function getCreditSummary(
  userId: string,
): Promise<{ balance: string; held: string; available: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { creditBalance: true, creditHeld: true },
  });
  const available = user.creditBalance.minus(user.creditHeld);
  return {
    balance: user.creditBalance.toFixed(4),
    held: user.creditHeld.toFixed(4),
    available: available.toFixed(4),
  };
}

/**
 * S7 — cursor-paginated, caller-scoped ledger read for
 * `GET /api/v1/me/credits/ledger` (assignment §10 "Ledger" row;
 * implementation plan §6.1 P1 stretch). Same (createdAt, id) keyset
 * pagination as `listChats`; `CreditLedger` already carries
 * `@@index([userId, createdAt])` so this read is index-backed, never an
 * unbounded scan.
 *
 * Only CAPTURE/USAGE rows are returned — the same "net debited" scope as
 * `getCreditUsageSummary`'s totals (credits.md "`/usage` — Action/'View
 * details' drill-down gap" fold-in). This is the *only* consumer of this
 * endpoint (UsageDetailedView's per-tool record table), and its own header
 * already renders `group.records` (a CAPTURE/USAGE-only count) as "N
 * records in the selected period" — before this filter, the list below it
 * silently included every RESERVE/RELEASE hold-lifecycle row too, so the
 * visible row count never matched that header. RESERVE/RELEASE remain
 * fully visible per-run via the "Usage details" modal's step breakdown
 * (`listCreditLedgerByRun`, unfiltered) — nothing is hidden, just not
 * duplicated as its own top-level "record".
 */
export async function listCreditLedger(userId: string, query: ListCreditLedgerQuery) {
  const limit = clampLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const where: Prisma.CreditLedgerWhereInput = { userId, kind: { in: ["CAPTURE", "USAGE"] } };
  // Optional tool-group scope (§ "Detailed View" tab) — "none" means bare
  // LLM usage (no ToolInvocation row), any other value is a registered
  // tool name matched through the toolInvocation relation.
  if (query.tool === NO_TOOL_KEY) {
    where.toolInvocationId = null;
  } else if (query.tool) {
    where.toolInvocation = { name: query.tool };
  }
  if (cursor) {
    where.OR = [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.creditLedger.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount.toFixed(4),
      createdAt: row.createdAt.toISOString(),
      runId: row.runId,
      toolInvocationId: row.toolInvocationId,
    })),
    nextCursor,
  };
}

/**
 * S7 — "Usage details" modal step breakdown for `GET
 * /api/v1/me/credits/ledger/run/[runId]` (credits.md "`/usage` — Action/
 * 'View details' drill-down gap"). Every ledger row sharing this runId —
 * the full RESERVE/CAPTURE/RELEASE/USAGE lifecycle, not just CAPTURE/USAGE
 * — ordered chronologically (oldest first, matching the reference's own
 * step order). Caller-scoped by `userId` on the ledger query itself: a
 * runId belonging to another user simply matches zero rows here, never a
 * separate ownership check against AgentRun. `chatId` is looked up only
 * once rows have proven ownership, so a stranger's runId can never be used
 * to fish for another user's chatId.
 */
export async function listCreditLedgerByRun(
  userId: string,
  runId: string,
): Promise<{
  chatId: string | null;
  items: Array<{
    id: string;
    kind: string;
    amount: string;
    createdAt: string;
    runId: string | null;
    toolInvocationId: string | null;
    toolName: string | null;
  }>;
}> {
  const rows = await prisma.creditLedger.findMany({
    where: { userId, runId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { toolInvocation: { select: { name: true } } },
  });

  if (rows.length === 0) {
    return { chatId: null, items: [] };
  }

  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { chatId: true } });

  return {
    chatId: run?.chatId ?? null,
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount.toFixed(4),
      createdAt: row.createdAt.toISOString(),
      runId: row.runId,
      toolInvocationId: row.toolInvocationId,
      toolName: row.toolInvocation?.name ?? null,
    })),
  };
}

// Title-cases an unmapped tool registry name (e.g. a future tool) so the
// dashboard never crashes or silently drops a row for a name outside the
// three known adapters.
function titleCaseToolName(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

// The tool-specific labels below ("AI Crop Image" etc.) were measured live
// against the reference product's /usage page (credits.md "/usage full
// dashboard") — exact wording, do not reword those. The NO_TOOL_KEY label
// is NOT reference-matched: it originally read "VyomFlow", but that name
// belongs to the cross-tool aggregate group now (AGGREGATE_TOOL_KEY, in
// getCreditUsageSummary) — VyomFlow is the whole product, not the
// bare-LLM-turn bucket, and showing "VyomFlow: 0.00M" read as "the app
// cost nothing" (2026-08-29 UX fix).
// Exported so route handlers (e.g. the "Usage details" modal's per-step
// tool label) can reuse the exact same mapping instead of duplicating it.
export function toolDisplayName(toolKey: string): string {
  if (toolKey === NO_TOOL_KEY) return "AI Reasoning";
  if (toolKey === AGGREGATE_TOOL_KEY) return "VyomFlow";
  switch (toolKey) {
    case CROP_IMAGE_TOOL_NAME:
      return "AI Crop Image";
    case GENERATE_IMAGE_TOOL_NAME:
      return "AI Generate Image";
    case MERGE_VIDEOS_TOOL_NAME:
      return "AI Merge Videos";
    default:
      return titleCaseToolName(toolKey);
  }
}

// One raw CAPTURE/USAGE row as fed into groupIntoUsageEntries — deliberately
// narrow (not the full Prisma row type) so both call sites below can share
// it without over-coupling to a specific `include` shape.
type UsageRow = {
  id: string;
  runId: string | null;
  amount: PrismaRuntime.Decimal;
  createdAt: Date;
  toolInvocation: { name: string } | null;
};

/**
 * Nets CAPTURE/USAGE rows into "usage entries" — one accumulator per
 * (toolKey, runId) pair (credits.md "`/usage` — Action/'View details'
 * drill-down gap", netted-rows fold-in). A single run/turn can write
 * several CAPTURE/USAGE rows (e.g. a bare-LLM USAGE row plus a tool
 * CAPTURE, or multiple tool calls in one turn) — the reference's own
 * Detailed View shows exactly one row per run, not one per raw ledger row,
 * and its Overview "Records" count matches that row count. Rows with a
 * null `runId` (should not happen in practice — every reserve/capture is
 * always created with a runId) fall back to their own row id as a solo
 * entry rather than being silently merged under one shared "no run" key.
 */
function groupIntoUsageEntries(rows: UsageRow[]): Map<string, Map<string, { amount: PrismaRuntime.Decimal; latest: Date }>> {
  const byTool = new Map<string, Map<string, { amount: PrismaRuntime.Decimal; latest: Date }>>();
  for (const row of rows) {
    const toolKey = row.toolInvocation?.name ?? NO_TOOL_KEY;
    const runKey = row.runId ?? `row:${row.id}`;
    let runs = byTool.get(toolKey);
    if (!runs) {
      runs = new Map();
      byTool.set(toolKey, runs);
    }
    const acc = runs.get(runKey) ?? { amount: new PrismaRuntime.Decimal(0), latest: row.createdAt };
    acc.amount = acc.amount.plus(row.amount);
    if (row.createdAt > acc.latest) acc.latest = row.createdAt;
    runs.set(runKey, acc);
  }
  return byTool;
}

/**
 * S7 — real per-tool usage aggregation for `GET
 * /api/v1/me/credits/usage-summary` (credits.md "/usage full dashboard —
 * re-verified": honestly derivable via GROUP BY toolInvocation.name over
 * data already persisted, not fabrication). Only CAPTURE/USAGE ledger kinds
 * permanently debit a user's balance — RESERVE/RELEASE are hold-lifecycle
 * bookkeeping and must never be counted here, or the same spend would be
 * double-counted against its own later CAPTURE. Grouped in application
 * code (small, per-user dataset — not the sweep.ts hot path, and Prisma's
 * `groupBy` can't group by a joined field anyway).
 *
 * `records`/`recordsAll` count distinct *usage entries* (one per run, via
 * `groupIntoUsageEntries`), not raw CAPTURE/USAGE ledger rows — matching
 * the Detailed View list's own row granularity one-for-one, per the
 * netted-rows fold-in above. `totalDebited`/`totalDebitedAll`/
 * `latestUsageAt` are unaffected by this — they're still the plain sum/max
 * over every row, since netting-by-run never changes a total or a max.
 */
export async function getCreditUsageSummary(userId: string, period: UsagePeriod = "all"): Promise<{
  groups: Array<{
    toolKey: string;
    displayName: string;
    totalDebited: string;
    records: number;
    latestUsageAt: string | null;
  }>;
  totalDebitedAll: string;
  recordsAll: number;
  categoriesCount: number;
  periodStart: string | null;
  periodEnd: string | null;
}> {
  const cutoff = periodCutoff(period);
  const rows = await prisma.creditLedger.findMany({
    where: { userId, kind: { in: ["CAPTURE", "USAGE"] }, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
    include: { toolInvocation: { select: { name: true } }, run: { select: { chatId: true } } },
  });

  const runsByTool = groupIntoUsageEntries(rows);

  type GroupAcc = { toolKey: string; total: PrismaRuntime.Decimal; latest: Date };
  const groups = new Map<string, GroupAcc>();
  let totalAll = new PrismaRuntime.Decimal(0);
  let recordsAll = 0;
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  const chatIds = new Set<string>();

  for (const row of rows) {
    const toolKey = row.toolInvocation?.name ?? NO_TOOL_KEY;
    const acc = groups.get(toolKey) ?? { toolKey, total: new PrismaRuntime.Decimal(0), latest: row.createdAt };
    acc.total = acc.total.plus(row.amount);
    if (row.createdAt > acc.latest) acc.latest = row.createdAt;
    groups.set(toolKey, acc);

    totalAll = totalAll.plus(row.amount);
    if (!periodStart || row.createdAt < periodStart) periodStart = row.createdAt;
    if (!periodEnd || row.createdAt > periodEnd) periodEnd = row.createdAt;
    if (row.run?.chatId) chatIds.add(row.run.chatId);
  }

  for (const runs of runsByTool.values()) {
    recordsAll += runs.size;
  }

  // The "VyomFlow" aggregate (2026-08-29) — the whole-product total across
  // every tool plus bare-LLM usage, prepended so it's the dropdown's default
  // selection (usage-detailed-view.tsx defaults to groups[0]). Deliberately
  // NOT folded into the `groups` Map above: that Map is also what
  // `categoriesCount` counts, and the aggregate is not a category — it's
  // the sum of all of them. `records` here counts distinct chats (this
  // group's Detailed View lists per-chat rows, not per-run — see
  // listUsageEntriesByChat), not the (tool, run) count the other groups use.
  const aggregateGroup = {
    toolKey: AGGREGATE_TOOL_KEY,
    displayName: toolDisplayName(AGGREGATE_TOOL_KEY),
    totalDebited: totalAll.toFixed(4),
    records: chatIds.size,
    latestUsageAt: periodEnd ? periodEnd.toISOString() : null,
  };

  return {
    groups: [
      aggregateGroup,
      ...Array.from(groups.values()).map((acc) => ({
        toolKey: acc.toolKey,
        displayName: toolDisplayName(acc.toolKey),
        totalDebited: acc.total.toFixed(4),
        records: runsByTool.get(acc.toolKey)?.size ?? 0,
        latestUsageAt: acc.latest.toISOString(),
      })),
    ],
    totalDebitedAll: totalAll.toFixed(4),
    recordsAll,
    categoriesCount: groups.size,
    periodStart: periodStart ? periodStart.toISOString() : null,
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
  };
}

/**
 * S7 — netted usage-entry list for the Detailed View tab's record table
 * (credits.md "`/usage` — Action/'View details' drill-down gap", netted-
 * rows fold-in). One row per run (via `groupIntoUsageEntries`), scoped to
 * a single tool bucket — the same `toolKey` values `getCreditUsageSummary`
 * and `listCreditLedger`'s `?tool=` already use ("none" for bare LLM
 * usage, otherwise a registered tool name). `amount` is the sum of that
 * run's CAPTURE/USAGE rows only (never RESERVE/RELEASE); `timestamp` is
 * the latest of those rows' `createdAt`. Unpaginated, like
 * `getCreditUsageSummary` — same small, per-user dataset, not the
 * sweep.ts hot path. The full raw RESERVE/CAPTURE/RELEASE/USAGE lifecycle
 * for any one entry stays available, unfiltered, via
 * `listCreditLedgerByRun(userId, runId)` — this function only changes what
 * counts as one top-level row, never what the "Usage details" modal shows
 * once a row is opened.
 */
export async function listUsageEntries(
  userId: string,
  tool: string,
  period: UsagePeriod = "all",
): Promise<Array<{ runId: string; amount: string; timestamp: string }>> {
  const cutoff = periodCutoff(period);
  const where: Prisma.CreditLedgerWhereInput = {
    userId,
    kind: { in: ["CAPTURE", "USAGE"] },
    ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
  };
  if (tool === NO_TOOL_KEY) {
    where.toolInvocationId = null;
  } else {
    where.toolInvocation = { name: tool };
  }

  const rows = await prisma.creditLedger.findMany({
    where,
    include: { toolInvocation: { select: { name: true } } },
  });

  const runs = groupIntoUsageEntries(rows).get(tool) ?? new Map<string, { amount: PrismaRuntime.Decimal; latest: Date }>();

  return Array.from(runs.entries())
    .map(([runKey, acc]) => ({
      runId: runKey.startsWith("row:") ? runKey.slice("row:".length) : runKey,
      amount: acc.amount.toFixed(4),
      timestamp: acc.latest.toISOString(),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

/**
 * S7 — per-chat netted usage for the "VyomFlow" aggregate group's Detailed
 * View (2026-08-29 UX fix). Every CAPTURE/USAGE row across every tool and
 * bare-LLM usage, netted by `run.chatId` instead of `(toolKey, runId)` —
 * "where did my credits go" answered by chat, not by an arbitrary run id
 * with no tool attached. A row whose run has no chat (should not happen —
 * every AgentRun has a chatId) is skipped rather than merged under a
 * synthetic bucket, matching groupIntoUsageEntries' own no-silent-merge
 * stance for its null-runId case.
 */
export async function listUsageEntriesByChat(
  userId: string,
  period: UsagePeriod = "all",
): Promise<Array<{ chatId: string; chatTitle: string; amount: string; timestamp: string }>> {
  const cutoff = periodCutoff(period);
  const rows = await prisma.creditLedger.findMany({
    where: { userId, kind: { in: ["CAPTURE", "USAGE"] }, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
    include: { run: { select: { chatId: true, chat: { select: { title: true } } } } },
  });

  const byChat = new Map<string, { chatTitle: string; amount: PrismaRuntime.Decimal; latest: Date }>();
  for (const row of rows) {
    if (!row.run?.chatId) continue;
    const acc = byChat.get(row.run.chatId) ?? {
      chatTitle: row.run.chat.title,
      amount: new PrismaRuntime.Decimal(0),
      latest: row.createdAt,
    };
    acc.amount = acc.amount.plus(row.amount);
    if (row.createdAt > acc.latest) acc.latest = row.createdAt;
    byChat.set(row.run.chatId, acc);
  }

  return Array.from(byChat.entries())
    .map(([chatId, acc]) => ({
      chatId,
      chatTitle: acc.chatTitle,
      amount: acc.amount.toFixed(4),
      timestamp: acc.latest.toISOString(),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}

/**
 * S7 — "VyomFlow" aggregate row's chat-scoped Details drill-down for `GET
 * /api/v1/me/credits/ledger/chat/[chatId]` (2026-08-29 UX fix). A chat's row
 * in `listUsageEntriesByChat` nets every tool/run in that chat into one
 * amount — this lists it back out one row per (tool, run) via the same
 * `groupIntoUsageEntries` netting `listUsageEntries` uses, just scoped to a
 * chat instead of a single tool. Caller-scoped by `userId` on the ledger
 * query itself (matching `listCreditLedgerByRun`'s own stance) — a chatId
 * belonging to another user simply matches zero rows, never a separate
 * ownership check.
 */
export async function listCreditLedgerByChat(
  userId: string,
  chatId: string,
): Promise<{ chatTitle: string | null; items: Array<{ runId: string; toolName: string | null; amount: string; timestamp: string }> }> {
  const rows = await prisma.creditLedger.findMany({
    where: { userId, kind: { in: ["CAPTURE", "USAGE"] }, run: { chatId } },
    include: { toolInvocation: { select: { name: true } }, run: { select: { chat: { select: { title: true } } } } },
  });

  if (rows.length === 0) {
    return { chatTitle: null, items: [] };
  }

  const runsByTool = groupIntoUsageEntries(rows);
  const items: Array<{ runId: string; toolName: string | null; amount: string; timestamp: string }> = [];
  for (const [toolKey, runs] of runsByTool) {
    for (const [runKey, acc] of runs) {
      items.push({
        runId: runKey.startsWith("row:") ? runKey.slice("row:".length) : runKey,
        toolName: toolKey === NO_TOOL_KEY ? null : toolKey,
        amount: acc.amount.toFixed(4),
        timestamp: acc.latest.toISOString(),
      });
    }
  }
  items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  return { chatTitle: rows[0]!.run!.chat.title, items };
}
