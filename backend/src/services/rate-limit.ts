/**
 * Application-level per-user send-rate limiting (S2-streaming-turn.md) —
 * distinct from, and in addition to, OpenRouter's own upstream 429s. Fixed
 * window, single indexed table (`rate_limit_windows`), no Redis/Upstash —
 * unrequested infrastructure at this scale (S2 spec, explicit).
 */
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { RATE_LIMIT_MAX_SENDS, RATE_LIMIT_WINDOW_MS } from "@/lib/config";

export class RateLimitedError extends Error {
  constructor() {
    super("You're sending too fast — please wait a moment and try again.");
    this.name = "RateLimitedError";
  }
}

function currentWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS);
}

/**
 * Atomically increments the caller's counter for the current fixed window
 * and throws RateLimitedError if that increment pushes it over the
 * configured threshold. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is
 * one round trip and race-safe under concurrent sends from the same user —
 * no separate read-then-write.
 */
export async function checkAndIncrementRateLimit(userId: string): Promise<void> {
  const windowStart = currentWindowStart(new Date());

  const rows = await prisma.$queryRaw<{ count: number }[]>(
    PrismaRuntime.sql`
      INSERT INTO "rate_limit_windows" ("userId", "windowStart", "count")
      VALUES (${userId}, ${windowStart}, 1)
      ON CONFLICT ("userId", "windowStart")
      DO UPDATE SET "count" = "rate_limit_windows"."count" + 1
      RETURNING "count"
    `,
  );

  const count = rows[0]?.count ?? 0;
  if (count > RATE_LIMIT_MAX_SENDS) {
    throw new RateLimitedError();
  }
}
