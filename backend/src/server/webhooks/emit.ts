/**
 * S8 Phase 6 — webhook emission. Called only from the durable finalizers
 * (src/server/agent/persist.ts) and the tool settlement path
 * (src/services/tool-invocations.ts) — never from a route handler or the
 * SSE layer (the plan's explicit ownership rule: a route only ever sees
 * dispatch, and SSE fires once per subscriber or never). Never inline
 * `fetch`s the receiver itself — that belongs to the bounded
 * `webhook-delivery` child task, so a slow/hanging receiver can never eat
 * into the calling turn's own duration budget.
 *
 * Triggers by string id + a type-only import of the task (`tasks.trigger<
 * typeof webhookDelivery>("webhook-delivery", ...)`), the same seam
 * src/server/dispatch.ts already uses for `agent-turn` — persist.ts and
 * tool-invocations.ts are loaded by nearly every route/service in the app,
 * so actually importing src/trigger/webhook-delivery.ts's module body (real
 * sharp-free but still a real `task()` registration) here would pull the
 * live Trigger.dev SDK task registration into that entire graph, including
 * every test that touches a finalizer. The type-only import keeps this
 * file's runtime footprint to `@trigger.dev/sdk`'s `tasks.trigger` only,
 * already mocked wholesale by every existing test's trigger-sdk-mock.
 */
import { randomUUID } from "node:crypto";
import { tasks } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";
import { getEnabledWebhookEndpoint } from "@/services/webhooks";
import type { webhookDelivery, WebhookDeliveryTaskPayload } from "@/trigger/webhook-delivery";
import type { WebhookEventType, WebhookEventPayload } from "@/server/webhooks/events";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Best-effort side channel: swallows every error itself (lookup failure,
 * DB write failure, Trigger.dev enqueue failure) and only logs — a webhook
 * problem must never fail or roll back the agent turn/tool settlement it
 * is reporting on.
 */
export async function emitWebhookEvent(params: {
  userId: string;
  eventType: WebhookEventType;
  payload: WebhookEventPayload;
}): Promise<void> {
  const { userId, eventType, payload } = params;
  try {
    const endpoint = await getEnabledWebhookEndpoint(userId);
    if (!endpoint) return;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId: randomUUID(),
        eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: "pending",
      },
    });

    const triggerPayload: WebhookDeliveryTaskPayload = { deliveryId: delivery.id };
    await tasks.trigger<typeof webhookDelivery>("webhook-delivery", triggerPayload, {
      idempotencyKey: delivery.id,
    });
  } catch (error) {
    log.error("webhook.emit_failed", {
      userId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
