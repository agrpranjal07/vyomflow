/**
 * Application-level per-user send-rate limiting (S2-streaming-turn.md) —
 * distinct from, and in addition to, OpenRouter's own upstream 429s. Fixed
 * window, single indexed table (`rate_limit_windows`), no Redis/Upstash —
 * unrequested infrastructure at this scale (S2 spec, explicit).
 */
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { RATE_LIMIT_MAX_SENDS, RATE_LIMIT_WINDOW_MS } from "@/lib/config";

// `limit`/`remaining`/`resetAt` are additive (S8 public API — the public
// send route surfaces these as X-RateLimit-*/Retry-After headers, see
// app/api/public/v1/chats/[chatId]/messages/route.ts). Nothing else
// constructs this class, so widening the constructor is safe.
export class RateLimitedError extends Error {
  constructor(
    public readonly limit: number,
    public readonly remaining: number,
    public readonly resetAt: Date,
  ) {
    super("You're sending too fast — please wait a moment and try again.");
    this.name = "RateLimitedError";
  }
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: Date;
}

function currentWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS);
}

/**
 * Atomically increments the caller's counter for the current fixed window
 * and throws RateLimitedError if that increment pushes it over the
 * configured threshold. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is
 * one round trip and race-safe under concurrent sends from the same subject
 * — no separate read-then-write. Returns the resulting rate-limit state on
 * success (existing callers that ignore the return value are unaffected).
 *
 * `subject` is a generic bucket key (S8 public API): a `userId` for the
 * first-party app's per-user limiting, or an `apiKeyId` for a public API
 * key's own bucket, so one abusive key can't throttle the same human's
 * browser session.
 */
export async function checkAndIncrementRateLimit(subject: string): Promise<RateLimitState> {
  const windowStart = currentWindowStart(new Date());
  const resetAt = new Date(windowStart.getTime() + RATE_LIMIT_WINDOW_MS);

  const rows = await prisma.$queryRaw<{ count: number }[]>(
    PrismaRuntime.sql`
      INSERT INTO "rate_limit_windows" ("subject", "windowStart", "count")
      VALUES (${subject}, ${windowStart}, 1)
      ON CONFLICT ("subject", "windowStart")
      DO UPDATE SET "count" = "rate_limit_windows"."count" + 1
      RETURNING "count"
    `,
  );

  const count = rows[0]?.count ?? 0;
  if (count > RATE_LIMIT_MAX_SENDS) {
    throw new RateLimitedError(RATE_LIMIT_MAX_SENDS, 0, resetAt);
  }
  return { limit: RATE_LIMIT_MAX_SENDS, remaining: Math.max(0, RATE_LIMIT_MAX_SENDS - count), resetAt };
}
