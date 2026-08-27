import { describe, it, expect } from "vitest";
import {
  webhookRetryDelayMs,
  isFinalWebhookAttempt,
  WEBHOOK_RETRY_SCHEDULE,
} from "@/server/webhooks/retry";

/**
 * Pure backoff-schedule tests (testing-policy.md: "structure it so the
 * backoff schedule is a pure function you can unit test... without waiting
 * real minutes"). src/trigger/webhook-delivery.ts passes the equivalent
 * minTimeoutInMs/maxTimeoutInMs/factor/maxAttempts to Trigger's own `retry`
 * option — this file proves the formula itself, independent of any live
 * Trigger.dev scheduler.
 */
describe("webhookRetryDelayMs", () => {
  it("5 attempts total, exponential 30s -> 10min (capped)", () => {
    expect(webhookRetryDelayMs(1)).toBe(0); // first attempt: no delay
    expect(webhookRetryDelayMs(2)).toBe(30_000); // 30s
    expect(webhookRetryDelayMs(3)).toBe(90_000); // 90s
    expect(webhookRetryDelayMs(4)).toBe(270_000); // 4.5min
    expect(webhookRetryDelayMs(5)).toBe(600_000); // capped at 10min (raw would be 810s)
  });

  it("never exceeds maxTimeoutInMs even for attempts beyond the configured schedule", () => {
    expect(webhookRetryDelayMs(6)).toBe(600_000);
    expect(webhookRetryDelayMs(20)).toBe(600_000);
  });

  it("is monotonically non-decreasing across attempts", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) => webhookRetryDelayMs(n));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it("respects a custom schedule passed explicitly", () => {
    const custom = { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 5_000, factor: 2 };
    expect(webhookRetryDelayMs(1, custom)).toBe(0);
    expect(webhookRetryDelayMs(2, custom)).toBe(1_000);
    expect(webhookRetryDelayMs(3, custom)).toBe(2_000);
    expect(webhookRetryDelayMs(4, custom)).toBe(4_000);
    expect(webhookRetryDelayMs(5, custom)).toBe(5_000); // capped
  });
});

describe("isFinalWebhookAttempt", () => {
  it("is false before the schedule's maxAttempts and true at/after it", () => {
    expect(isFinalWebhookAttempt(1)).toBe(false);
    expect(isFinalWebhookAttempt(4)).toBe(false);
    expect(isFinalWebhookAttempt(5)).toBe(true);
    expect(isFinalWebhookAttempt(6)).toBe(true);
  });
});

describe("WEBHOOK_RETRY_SCHEDULE", () => {
  it("matches the plan's documented shape: 5 attempts, 30s -> 10min", () => {
    expect(WEBHOOK_RETRY_SCHEDULE.maxAttempts).toBe(5);
    expect(WEBHOOK_RETRY_SCHEDULE.minTimeoutInMs).toBe(30_000);
    expect(WEBHOOK_RETRY_SCHEDULE.maxTimeoutInMs).toBe(600_000);
  });
});
