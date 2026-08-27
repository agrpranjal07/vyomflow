import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
// "@trigger.dev/sdk" itself is aliased at the Vite config level
// (vitest.integration.config.mts) to ../support/trigger-sdk-mock — see that
// config's comment. `tasks.trigger` there is a plain vi.fn(), which is also
// what makes the real `task({...})` in src/trigger/webhook-delivery.ts
// resolve to the options object itself (`task = vi.fn((opts) => opts)`),
// so `webhookDelivery.onFailure` below is directly callable.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { tasks } from "@trigger.dev/sdk";
import { testDb } from "../support/db";
import { authedRequest, anonymousRequest } from "../support/request";
import { POST as setWebhook } from "@/app/api/v1/webhooks/route";
import { markRunning, finalizeCompleted, finalizeFailed, createAssistantMessage } from "@/server/agent/persist";
import { markToolCompleted } from "@/services/tool-invocations";
import { executeWebhookDelivery, webhookDelivery, type WebhookDeliveryTaskPayload } from "@/trigger/webhook-delivery";
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_DELIVERY_ATTEMPT_HEADER,
} from "@/server/webhooks/signing";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  vi.mocked(tasks.trigger).mockClear();
});

const WEBHOOKS_BASE = "http://localhost/api/v1/webhooks";
const RECEIVER_URL = "https://receiver.test/hooks/vyomflow";

async function makeUser(clerkUserId: string) {
  return testDb.user.create({ data: { clerkUserId } });
}

async function makeChatAndRun(ownerId: string) {
  const chat = await testDb.chat.create({ data: { ownerId, title: "t" } });
  const userMessage = await testDb.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  const run = await testDb.agentRun.create({
    data: {
      chatId: chat.id,
      idempotencyKey: `send:${chat.id}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
    },
  });
  return { chat, userMessage, run };
}

async function makeToolInvocation(agentRunId: string, toolCallId: string) {
  return testDb.toolInvocation.create({
    data: { agentRunId, turnIndex: 0, callIndex: 0, toolCallId, name: "crop_image", nodeType: "crop_image", input: {} },
  });
}

/** Directly registers an enabled endpoint for a user, bypassing the route (tests that don't care about registration itself). */
async function registerEndpoint(userId: string, url = RECEIVER_URL) {
  return testDb.webhookEndpoint.create({ data: { userId, url, secret: "endpoint-secret" } });
}

describe("POST /api/v1/webhooks — registration and rotation", () => {
  it("requires authentication", async () => {
    const res = await setWebhook(anonymousRequest(WEBHOOKS_BASE, { method: "POST", body: JSON.stringify({ url: RECEIVER_URL }) }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid url", async () => {
    const user = await makeUser("user_webhook_badurl");
    const res = await setWebhook(authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: "not-a-url" }) }));
    expect(res.status).toBe(400);
  });

  it("first call creates the endpoint with a generated secret and a null secondarySecret", async () => {
    const user = await makeUser("user_webhook_create");
    const res = await setWebhook(authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: RECEIVER_URL }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(RECEIVER_URL);
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(20);
    expect(body.secondarySecret).toBeNull();
    expect(body.enabled).toBe(true);

    const rows = await testDb.webhookEndpoint.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });

  it("a second call without rotateSecret updates the url but keeps the same secret (one row per user)", async () => {
    const user = await makeUser("user_webhook_update");
    const first = await setWebhook(authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: RECEIVER_URL }) }));
    const firstBody = await first.json();

    const second = await setWebhook(
      authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: `${RECEIVER_URL}/v2` }) }),
    );
    const secondBody = await second.json();

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.url).toBe(`${RECEIVER_URL}/v2`);
    expect(secondBody.secret).toBe(firstBody.secret);
    expect(secondBody.secondarySecret).toBeNull();

    const rows = await testDb.webhookEndpoint.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });

  it("rotateSecret:true moves the current secret to secondarySecret and issues a fresh secret", async () => {
    const user = await makeUser("user_webhook_rotate");
    const first = await setWebhook(authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: RECEIVER_URL }) }));
    const firstBody = await first.json();

    const rotated = await setWebhook(
      authedRequest(WEBHOOKS_BASE, user.clerkUserId, {
        method: "POST",
        body: JSON.stringify({ url: RECEIVER_URL, rotateSecret: true }),
      }),
    );
    const rotatedBody = await rotated.json();

    expect(rotatedBody.secret).not.toBe(firstBody.secret);
    expect(rotatedBody.secondarySecret).toBe(firstBody.secret);
  });

  it("rotateSecret:true on first registration is a no-op rotation (nothing to rotate yet)", async () => {
    const user = await makeUser("user_webhook_rotate_first");
    const res = await setWebhook(
      authedRequest(WEBHOOKS_BASE, user.clerkUserId, { method: "POST", body: JSON.stringify({ url: RECEIVER_URL, rotateSecret: true }) }),
    );
    const body = await res.json();
    expect(body.secondarySecret).toBeNull();
  });
});

describe("finalizer webhook emission — enqueues a WebhookDelivery + triggers the child task", () => {
  it("markRunning (agent.started) enqueues nothing when the user has no registered endpoint", async () => {
    const user = await makeUser("user_webhook_no_endpoint");
    const { run } = await makeChatAndRun(user.id);

    const claimed = await markRunning(run.id, "trigger_1");
    expect(claimed).toBe(true);

    const deliveries = await testDb.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(0);
    expect(tasks.trigger).not.toHaveBeenCalled();
  });

  it("markRunning fires agent.started with the right payload shape and triggers the delivery task", async () => {
    const user = await makeUser("user_webhook_started");
    const endpoint = await registerEndpoint(user.id);
    const { run, chat } = await makeChatAndRun(user.id);

    await markRunning(run.id, "trigger_1");

    const deliveries = await testDb.webhookDelivery.findMany({ where: { endpointId: endpoint.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventType).toBe("agent.started");
    expect(deliveries[0].status).toBe("pending");
    const payload = deliveries[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ runId: run.id, chatId: chat.id, status: "running" });
    expect(typeof payload.occurredAt).toBe("string");

    expect(tasks.trigger).toHaveBeenCalledTimes(1);
    const [taskId, triggerPayload, opts] = vi.mocked(tasks.trigger).mock.calls[0] as unknown as [
      string,
      WebhookDeliveryTaskPayload,
      { idempotencyKey?: string },
    ];
    expect(taskId).toBe("webhook-delivery");
    expect(triggerPayload.deliveryId).toBe(deliveries[0].id);
    expect(opts.idempotencyKey).toBe(deliveries[0].id);
  });

  it("finalizeCompleted fires agent.completed", async () => {
    const user = await makeUser("user_webhook_completed");
    const endpoint = await registerEndpoint(user.id);
    const { run, chat } = await makeChatAndRun(user.id);
    await markRunning(run.id, "trigger_1");
    const assistantMessageId = await createAssistantMessage(run.id, chat.id);

    await finalizeCompleted({
      runId: run.id,
      assistantMessageId,
      blocks: [{ type: "text", text: "done" }],
      resolvedModel: "openrouter/free",
      usage: undefined,
    });

    const deliveries = await testDb.webhookDelivery.findMany({
      where: { endpointId: endpoint.id, eventType: "agent.completed" },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({ runId: run.id, chatId: chat.id, status: "completed" });
  });

  it("finalizeFailed fires agent.failed with the errorCode", async () => {
    const user = await makeUser("user_webhook_failed");
    const endpoint = await registerEndpoint(user.id);
    const { run } = await makeChatAndRun(user.id);

    await finalizeFailed({
      runId: run.id,
      assistantMessageId: null,
      errorCode: "generation_interrupted",
      errorMessage: "boom",
      fromStatus: "queued",
    });

    const deliveries = await testDb.webhookDelivery.findMany({
      where: { endpointId: endpoint.id, eventType: "agent.failed" },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({ runId: run.id, status: "failed", errorCode: "generation_interrupted" });
  });

  it("markToolCompleted fires tool.completed with the tool's identity and settled credit", async () => {
    const user = await makeUser("user_webhook_tool");
    const endpoint = await registerEndpoint(user.id);
    const { run } = await makeChatAndRun(user.id);
    const invocation = await makeToolInvocation(run.id, "call_1");

    const settled = await markToolCompleted({
      toolInvocationId: invocation.id,
      resultUrls: ["https://cdn.test/out.png"],
      creditUsedApp: 0.1,
      durationMs: 1200,
    });
    expect(settled).toBe(true);

    const deliveries = await testDb.webhookDelivery.findMany({
      where: { endpointId: endpoint.id, eventType: "tool.completed" },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({
      runId: run.id,
      toolInvocationId: invocation.id,
      name: "crop_image",
      status: "COMPLETED",
      creditUsed: 0.1,
    });
  });

  it("a race-losing markToolCompleted (already-terminal row) never double-emits", async () => {
    const user = await makeUser("user_webhook_tool_race");
    const endpoint = await registerEndpoint(user.id);
    const { run } = await makeChatAndRun(user.id);
    const invocation = await makeToolInvocation(run.id, "call_1");

    await testDb.toolInvocation.update({ where: { id: invocation.id }, data: { status: "CANCELLED" } });
    const settled = await markToolCompleted({
      toolInvocationId: invocation.id,
      resultUrls: [],
      creditUsedApp: 0,
      durationMs: 10,
    });
    expect(settled).toBe(false);

    const deliveries = await testDb.webhookDelivery.findMany({ where: { endpointId: endpoint.id } });
    expect(deliveries).toHaveLength(0);
  });
});

describe("webhook-delivery task — signing, delivery, retry, dead-lettering", () => {
  async function makeDelivery(userId: string, eventType = "agent.started") {
    const endpoint = await registerEndpoint(userId);
    const delivery = await testDb.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId: `evt_${Math.random().toString(36).slice(2)}`,
        eventType,
        payload: { runId: "run_1", chatId: "chat_1", status: "running", occurredAt: new Date().toISOString() },
        status: "pending",
      },
    });
    return { endpoint, delivery };
  }

  it("a 2xx receiver response marks the delivery delivered, with a valid signature over the exact sent body", async () => {
    const user = await makeUser("user_webhook_deliver_ok");
    const { endpoint, delivery } = await makeDelivery(user.id);

    let capturedHeaders: Headers | undefined;
    let capturedBody = "";
    server.use(
      http.post(RECEIVER_URL, async ({ request }) => {
        capturedHeaders = request.headers;
        capturedBody = await request.text();
        return HttpResponse.json({ ok: true }, { status: 200 });
      }),
    );

    const result = await executeWebhookDelivery({ deliveryId: delivery.id }, { ctx: { attempt: { number: 1 } } });
    expect(result).toEqual({ status: "delivered", statusCode: 200 });

    const refreshed = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(refreshed.status).toBe("delivered");
    expect(refreshed.lastStatusCode).toBe(200);
    expect(refreshed.deliveredAt).not.toBeNull();

    expect(capturedHeaders?.get(WEBHOOK_EVENT_ID_HEADER)).toBe(delivery.eventId);
    expect(capturedHeaders?.get(WEBHOOK_DELIVERY_ATTEMPT_HEADER)).toBe("1");
    const timestamp = capturedHeaders?.get(WEBHOOK_TIMESTAMP_HEADER) ?? "";
    const signature = capturedHeaders?.get(WEBHOOK_SIGNATURE_HEADER) ?? "";
    expect(verifyWebhookSignature(capturedBody, timestamp, endpoint.secret, signature)).toBe(true);
    // The body actually sent must be exactly JSON.stringify(delivery.payload) — never re-serialized differently.
    expect(capturedBody).toBe(JSON.stringify(delivery.payload));
  });

  it("a non-2xx receiver response records the attempt and throws (so Trigger.dev's own retry fires), leaving the row pending", async () => {
    const user = await makeUser("user_webhook_deliver_fail");
    const { delivery } = await makeDelivery(user.id);

    server.use(http.post(RECEIVER_URL, () => HttpResponse.json({ error: "nope" }, { status: 500 })));

    await expect(executeWebhookDelivery({ deliveryId: delivery.id }, { ctx: { attempt: { number: 1 } } })).rejects.toThrow();

    const refreshed = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(refreshed.status).toBe("pending");
    expect(refreshed.lastStatusCode).toBe(500);
    expect(refreshed.attempt).toBe(1);
  });

  it("a network failure (no responder registered) also records the attempt and throws", async () => {
    const user = await makeUser("user_webhook_deliver_network_fail");
    const { delivery } = await makeDelivery(user.id);
    // No `server.use` handler registered for RECEIVER_URL — msw's
    // onUnhandledRequest: "error" makes the outbound fetch itself reject.

    await expect(executeWebhookDelivery({ deliveryId: delivery.id }, { ctx: { attempt: { number: 1 } } })).rejects.toThrow();

    const refreshed = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(refreshed.status).toBe("pending");
    expect(refreshed.lastStatusCode).toBeNull();
    expect(refreshed.attempt).toBe(1);
  });

  it("an already-settled row (idempotent re-entry) is a no-op — never re-delivers", async () => {
    const user = await makeUser("user_webhook_deliver_settled");
    const { delivery } = await makeDelivery(user.id);
    await testDb.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "delivered" } });

    const result = await executeWebhookDelivery({ deliveryId: delivery.id }, { ctx: { attempt: { number: 2 } } });
    expect(result).toEqual({ status: "already_settled" });
  });

  it("onFailure (fired once Trigger.dev's own retries are exhausted) dead-letters the row without touching a fresher lastStatusCode/attempt", async () => {
    const user = await makeUser("user_webhook_deliver_dead");
    const { delivery } = await makeDelivery(user.id);

    server.use(http.post(RECEIVER_URL, () => HttpResponse.json({ error: "still down" }, { status: 503 })));
    await expect(executeWebhookDelivery({ deliveryId: delivery.id }, { ctx: { attempt: { number: 5 } } })).rejects.toThrow();

    const beforeDead = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(beforeDead.status).toBe("pending");
    expect(beforeDead.lastStatusCode).toBe(503);
    expect(beforeDead.attempt).toBe(5);

    await webhookDelivery.onFailure?.({
      payload: { deliveryId: delivery.id },
      // Real onFailure params carry many more fields (error, ctx.task, ...)
      // — only ctx.attempt.number is read.
      ctx: { attempt: { number: 5 } },
    } as unknown as Parameters<NonNullable<typeof webhookDelivery.onFailure>>[0]);

    const dead = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(dead.status).toBe("dead");
    // onFailure must not clobber the real 503 already recorded by the last attempt.
    expect(dead.lastStatusCode).toBe(503);
    expect(dead.attempt).toBe(5);
  });

  it("dead-lettering is idempotent — calling onFailure twice never errors and stays dead", async () => {
    const user = await makeUser("user_webhook_deliver_dead_twice");
    const { delivery } = await makeDelivery(user.id);
    await testDb.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "dead", attempt: 5, lastStatusCode: 500 } });

    await webhookDelivery.onFailure?.({
      payload: { deliveryId: delivery.id },
      ctx: { attempt: { number: 5 } },
    } as unknown as Parameters<NonNullable<typeof webhookDelivery.onFailure>>[0]);

    const dead = await testDb.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(dead.status).toBe("dead");
  });
});
