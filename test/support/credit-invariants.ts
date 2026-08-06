/**
 * Shared credit-invariant assertion (S7 plan §9.1 / §B.14) — reused by every
 * credit-mutating integration test rather than each file re-deriving its own
 * ad hoc balance checks. Verifies the properties `services/credits.ts`'s
 * settlement functions are supposed to uphold as a matter of construction:
 *
 *   - `User.creditHeld` always equals the sum of `amount - capturedAmount`
 *     across that user's still-OPEN holds (closed holds contribute nothing —
 *     their remainder was already folded back by `releaseHold`/`captureForTool`).
 *   - `User.creditBalance` always equals `startingBalance` minus the sum of
 *     every `CAPTURE` ledger row for that user (the only ledger kind that
 *     actually debits `creditBalance` — RESERVE/RELEASE only move `creditHeld`,
 *     USAGE is a zero-cost record).
 *   - Neither value is ever negative.
 *   - Every `CreditLedger.idempotencyKey` for the user is unique (the DB
 *     constraint already guarantees this, but a duplicate key stored via two
 *     different casings/formats would still slip past that) and matches the
 *     key shape `services/credits.ts` actually writes for its kind.
 *
 * `startingBalance` is a parameter, not `CREDIT_STARTING_BALANCE` from
 * config, because individual tests seed users at arbitrary balances
 * (e.g. `makeUser(id, 0.02)` to exercise the insufficient-credits path) —
 * this helper checks arithmetic consistency against whatever the test
 * actually started from, not against the app's real default.
 */
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { testDb } from "./db";

const IDEMPOTENCY_KEY_SHAPE: Record<string, RegExp> = {
  // reserve:{runId} (turn admission) or reserve:{runId}:{toolInvocationId} (D2 top-up)
  RESERVE: /^reserve:[^:]+(:[^:]+)?$/,
  // capture:{toolInvocationId}
  CAPTURE: /^capture:[^:]+$/,
  // release:{runId}
  RELEASE: /^release:[^:]+$/,
  // usage:{runId}:{turnIndex}
  USAGE: /^usage:[^:]+:\d+$/,
};

export async function assertCreditInvariants(
  userId: string,
  startingBalance: number | PrismaRuntime.Decimal,
): Promise<void> {
  const user = await testDb.user.findUniqueOrThrow({ where: { id: userId } });
  const holds = await testDb.creditHold.findMany({ where: { userId } });
  const ledger = await testDb.creditLedger.findMany({ where: { userId } });

  // creditHeld reconciles exactly against the sum of open remainders.
  const expectedHeld = holds
    .filter((h) => h.status === "OPEN")
    .reduce((sum, h) => sum.plus(h.amount.minus(h.capturedAmount)), new PrismaRuntime.Decimal(0));
  if (!user.creditHeld.equals(expectedHeld)) {
    throw new Error(
      `credit invariant violated: User.creditHeld (${user.creditHeld.toString()}) !== sum of OPEN hold remainders (${expectedHeld.toString()}) for user ${userId}`,
    );
  }

  // creditBalance reconciles exactly against starting balance minus captures.
  const totalCaptured = ledger
    .filter((row) => row.kind === "CAPTURE")
    .reduce((sum, row) => sum.plus(row.amount), new PrismaRuntime.Decimal(0));
  const expectedBalance = new PrismaRuntime.Decimal(startingBalance).minus(totalCaptured);
  if (!user.creditBalance.equals(expectedBalance)) {
    throw new Error(
      `credit invariant violated: User.creditBalance (${user.creditBalance.toString()}) !== startingBalance - captured (${expectedBalance.toString()}) for user ${userId}`,
    );
  }

  // Neither value is ever negative.
  if (user.creditBalance.isNegative()) {
    throw new Error(`credit invariant violated: User.creditBalance is negative (${user.creditBalance.toString()}) for user ${userId}`);
  }
  if (user.creditHeld.isNegative()) {
    throw new Error(`credit invariant violated: User.creditHeld is negative (${user.creditHeld.toString()}) for user ${userId}`);
  }

  // Every idempotencyKey is unique (DB-enforced, re-checked here defensively)
  // and shaped as the kind that produced it actually writes.
  const seenKeys = new Set<string>();
  for (const row of ledger) {
    if (seenKeys.has(row.idempotencyKey)) {
      throw new Error(`credit invariant violated: duplicate idempotencyKey "${row.idempotencyKey}" for user ${userId}`);
    }
    seenKeys.add(row.idempotencyKey);

    const shape = IDEMPOTENCY_KEY_SHAPE[row.kind];
    if (shape && !shape.test(row.idempotencyKey)) {
      throw new Error(
        `credit invariant violated: idempotencyKey "${row.idempotencyKey}" does not match the expected shape for kind ${row.kind}`,
      );
    }
  }
}
