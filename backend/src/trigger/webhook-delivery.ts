/**
 * Per-delivery Trigger.dev child task (S8 Phase 6) — the only place that
 * actually `fetch`es a user's webhook receiver. Enqueued (never awaited)
 * by src/server/webhooks/emit.ts from the durable finalizers/tool
 * settlement path, so a slow/hanging receiver can never eat into the
 * calling turn's own duration budget.
 *
 * Retry choice: Trigger's own `retry` option (maxAttempts/factor/
 * minTimeoutInMs/maxTimeoutInMs, verified against the installed SDK's own
 * docs — node_modules/.pnpm/@trigger.dev+sdk.../docs/tasks/overview.mdx)
 * already expresses exactly "5 attempts, exponential 30s -> 10min" — no
 * need to hand-roll sleep/schedule logic inside the task body, which would
 * also have to fit inside one `maxDuration` window instead of Trigger's own
 * cross-attempt scheduling. server/webhooks/retry.ts documents and
 * unit-tests the same formula independently of Trigger's scheduler.
 */
import { task } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";
import { WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS, WEBHOOK_DELIVERY_QUEUE_CONCURRENCY } from "@/lib/config";
import { WEBHOOK_RETRY_SCHEDULE } from "@/server/webhooks/retry";
import {
  signWebhookPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_DELIVERY_ATTEMPT_HEADER,
} from "@/server/webhooks/signing";
import {
  markDeliveryDelivered,
  recordDeliveryAttemptFailure,
  markDeliveryDead,
} from "@/services/webhook-deliveries";

export interface WebhookDeliveryTaskPayload {
  deliveryId: string;
}

/** A non-2xx receiver response or network failure — always retried (via a throw), never treated as a hard bug. */
class WebhookDeliveryAttemptFailedError extends Error {}

/**
 * The task's `run` body, exported directly so it can be invoked in tests
 * without a live Trigger.dev runtime (mirrors src/trigger/tool.ts's
 * `executeMediaTool` pattern).
 */
export async function executeWebhookDelivery(
  payload: WebhookDeliveryTaskPayload,
  { ctx }: { ctx: { attempt: { number: number } } },
): Promise<{ status: "delivered"; statusCode: number } | { status: "already_settled" }> {
  const { deliveryId } = payload;
  const attempt = ctx.attempt.number;

  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  // Idempotent re-entry (a duplicate trigger, a retry racing a row already
  // settled by a prior attempt) — never re-fetch an already-terminal row.
  if (delivery.status !== "pending") {
    return { status: "already_settled" };
  }

  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Date.now().toString();
  const signature = signWebhookPayload(rawBody, timestamp, delivery.endpoint.secret);

  let response: Response;
  try {
    response = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_EVENT_ID_HEADER]: delivery.eventId,
        [WEBHOOK_DELIVERY_ATTEMPT_HEADER]: String(attempt),
      },
      body: rawBody,
      signal: AbortSignal.timeout(WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    await recordDeliveryAttemptFailure({ deliveryId, statusCode: null, attempt });
    log.error("webhook.delivery_attempt_failed", { deliveryId, attempt, error: err instanceof Error ? err.message : String(err) });
    throw new WebhookDeliveryAttemptFailedError("Webhook receiver request failed (network/timeout).");
  }

  if (response.ok) {
    await markDeliveryDelivered({ deliveryId, statusCode: response.status, attempt });
    return { status: "delivered", statusCode: response.status };
  }

  await recordDeliveryAttemptFailure({ deliveryId, statusCode: response.status, attempt });
  log.error("webhook.delivery_attempt_failed", { deliveryId, attempt, statusCode: response.status });
  throw new WebhookDeliveryAttemptFailedError(`Webhook receiver responded ${response.status}.`);
}

export const webhookDelivery = task({
  id: "webhook-delivery",
  queue: { name: "webhook-delivery", concurrencyLimit: WEBHOOK_DELIVERY_QUEUE_CONCURRENCY },
  retry: {
    maxAttempts: WEBHOOK_RETRY_SCHEDULE.maxAttempts,
    factor: WEBHOOK_RETRY_SCHEDULE.factor,
    minTimeoutInMs: WEBHOOK_RETRY_SCHEDULE.minTimeoutInMs,
    maxTimeoutInMs: WEBHOOK_RETRY_SCHEDULE.maxTimeoutInMs,
    randomize: false,
  },
  maxDuration: 30,
  run: executeWebhookDelivery,
  // Fires exactly once, only after every retry above is exhausted — the
  // dead-letter transition. `ctx.attempt.number` here is the final attempt
  // that just failed, which is exactly WEBHOOK_RETRY_SCHEDULE.maxAttempts.
  onFailure: async ({ payload, ctx }) => {
    await markDeliveryDead(payload.deliveryId);
    log.error("webhook.delivery_dead", { deliveryId: payload.deliveryId, attempt: ctx.attempt.number });
  },
});
