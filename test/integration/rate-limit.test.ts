import { describe, it, expect } from "vitest";
import { checkAndIncrementRateLimit, RateLimitedError } from "@/services/rate-limit";
import { RATE_LIMIT_MAX_SENDS } from "@/lib/config";
import { testDb } from "../support/db";

describe("application-level send rate limit", () => {
  it("allows up to the configured threshold within one window", async () => {
    const userId = "user_rate_1";
    for (let i = 0; i < RATE_LIMIT_MAX_SENDS; i++) {
      await expect(checkAndIncrementRateLimit(userId)).resolves.toBeUndefined();
    }
  });

  it("rejects the request that exceeds the threshold, before any AgentRun/hold would be created", async () => {
    const userId = "user_rate_2";
    for (let i = 0; i < RATE_LIMIT_MAX_SENDS; i++) {
      await checkAndIncrementRateLimit(userId);
    }

    await expect(checkAndIncrementRateLimit(userId)).rejects.toBeInstanceOf(RateLimitedError);

    // Confirm the guard is purely a counter check — no run/hold table is
    // touched by this service at all.
    const runs = await testDb.agentRun.count();
    expect(runs).toBe(0);
  });

  it("tracks separate users independently", async () => {
    const a = "user_rate_a";
    const b = "user_rate_b";
    for (let i = 0; i < RATE_LIMIT_MAX_SENDS; i++) {
      await checkAndIncrementRateLimit(a);
    }
    // b's own window is untouched by a's usage.
    await expect(checkAndIncrementRateLimit(b)).resolves.toBeUndefined();
  });
});
