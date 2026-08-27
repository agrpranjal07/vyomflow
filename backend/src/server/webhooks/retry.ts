/**
 * S8 Phase 6 — pure backoff schedule for webhook delivery retries, kept
 * independent of Trigger.dev's own scheduler so it is unit-testable without
 * waiting real minutes (testing-policy.md). `src/trigger/webhook-delivery.ts`
 * passes the equivalent `minTimeoutInMs`/`maxTimeoutInMs`/`factor`/
 * `maxAttempts` to the task's own `retry` option (verified against the
 * installed `@trigger.dev/core` `RetryOptions`/`calculateNextRetryDelay`
 * shape) so Trigger's actual attempt-scheduling is a thin wrapper around
 * the same formula this module documents and tests — not a second,
 * independently-drifting implementation.
 *
 * `attempt` here is 1-based and counts the attempt about to run (1 = the
 * very first try, with zero delay before it) — distinct from Trigger's own
 * `calculateNextRetryDelay(options, attempt)`, whose `attempt` counts
 * already-failed attempts (starts at 1 after the first failure); the two
 * are offset by exactly one, documented so nobody re-derives this by trial
 * and error.
 */
export interface WebhookRetrySchedule {
  maxAttempts: number;
  minTimeoutInMs: number;
  maxTimeoutInMs: number;
  factor: number;
}

/** 5 attempts total, exponential 30s -> 10min (per the plan): 0s, 30s, 90s, 270s, 600s(capped). */
export const WEBHOOK_RETRY_SCHEDULE: WebhookRetrySchedule = {
  maxAttempts: 5,
  minTimeoutInMs: 30_000,
  maxTimeoutInMs: 600_000,
  factor: 3,
};

/** Delay before running `attempt` (1-based), given the previous attempt failed. Attempt 1 has no delay. */
export function webhookRetryDelayMs(attempt: number, schedule: WebhookRetrySchedule = WEBHOOK_RETRY_SCHEDULE): number {
  if (attempt <= 1) return 0;
  const raw = schedule.minTimeoutInMs * Math.pow(schedule.factor, attempt - 2);
  return Math.min(raw, schedule.maxTimeoutInMs);
}

/** Whether `attempt` (1-based, the one that just failed) was the last allowed try — the row should be marked `dead`. */
export function isFinalWebhookAttempt(attempt: number, schedule: WebhookRetrySchedule = WEBHOOK_RETRY_SCHEDULE): boolean {
  return attempt >= schedule.maxAttempts;
}
