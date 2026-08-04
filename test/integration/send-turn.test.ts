import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { dispatchAgentTurn, mintRealtimeToken, resetTriggerMocks } from "../support/trigger-mock";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

function sendReq(chatId: string, userId: string, body: unknown) {
  return sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ chatId }) },
  );
}

beforeEach(() => resetTriggerMocks());

describe("send turn — happy path envelope", () => {
  it("returns chatId, message, run, and realtime access; dispatches exactly once", async () => {
    const userId = "user_send_1";
    const chat = await createChatAs(userId);

    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.chatId).toBe(chat.id);
    expect(body.message.role).toBe("user");
    expect(body.run.status).toBe("queued");
    expect(body.run.requestedModel).toBe("openrouter/free");
    expect(body.run.lastStreamIndex).toBe(-1);
    // realtime.runId is the Trigger.dev run id (what @trigger.dev/react-hooks'
    // useRealtimeStream/useRealtimeRun subscribe by), not this app's own
    // AgentRun.id — see frontend/src/hooks/use-active-run.ts.
    expect(body.realtime.accessToken).toBeTruthy();
    expect(dispatchAgentTurn).toHaveBeenCalledTimes(1);

    const run = await testDb.agentRun.findUniqueOrThrow({ where: { id: body.run.id } });
    expect(run.triggerRunId).toBe(`run_test_${run.id}`);
    expect(body.realtime.runId).toBe(run.triggerRunId);
  });
});

describe("send turn — model-selection validation (route level)", () => {
  const userId = "user_send_model";

  it("absent model defaults to openrouter/free and dispatches", async () => {
    const chat = await createChatAs(userId);
    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run.requestedModel).toBe("openrouter/free");
  });

  it("explicit openrouter/free is accepted and dispatches", async () => {
    const chat = await createChatAs(userId);
    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }], model: "openrouter/free" });
    expect(res.status).toBe(201);
  });

  it("a paid/unsupported model id is rejected before dispatch", async () => {
    const chat = await createChatAs(userId);
    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }], model: "openai/gpt-4o" });
    expect(res.status).toBe(400);
    expect(dispatchAgentTurn).not.toHaveBeenCalled();
    const runs = await testDb.agentRun.count({ where: { chatId: chat.id } });
    expect(runs).toBe(0);
  });

  it("a malformed model field is rejected before dispatch, distinct from absent", async () => {
    const chat = await createChatAs(userId);
    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }], model: "" });
    expect(res.status).toBe(400);
    expect(dispatchAgentTurn).not.toHaveBeenCalled();
  });
});

describe("send turn — rate limiting", () => {
  it("rejects a send over the configured threshold before any AgentRun/hold exists", async () => {
    // The limiter uses a fixed window keyed off Math.floor(now / windowMs)
    // (see services/rate-limit.ts's currentWindowStart) — pinning the clock
    // for this burst keeps the whole 11-send sequence inside one
    // deterministic window. Without this, the burst intermittently straddled
    // a real minute-window boundary, legitimately resetting the counter
    // mid-test (~1-in-5 flake) — the limiter itself is correct, this is a
    // test-clock fix only.
    vi.setSystemTime(new Date());
    try {
      const userId = "user_send_rate";
      const chat = await createChatAs(userId);

      // Each send's run is finalized immediately so subsequent sends aren't
      // blocked by the one-active-run-per-chat invariant instead of the
      // rate limiter — isolating the behavior under test.
      for (let i = 0; i < 10; i++) {
        const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: `m${i}` }] });
        expect(res.status).toBe(201);
        const { run } = await res.json();
        await testDb.agentRun.update({ where: { id: run.id }, data: { status: "completed" } });
      }

      const overLimit = await sendReq(chat.id, userId, { content: [{ type: "text", text: "one too many" }] });
      expect(overLimit.status).toBe(429);
      const body = await overLimit.json();
      expect(body.error.code).toBe("RATE_LIMITED");

      const runCountAfter = await testDb.agentRun.count({ where: { chatId: chat.id } });
      expect(runCountAfter).toBe(10); // the 11th request never created a row
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("send turn — realtime token mint failure after successful dispatch (hardening pass)", () => {
  it("a transient mint failure is retried once and still succeeds with a normal 201", async () => {
    const userId = "user_send_mint_retry";
    const chat = await createChatAs(userId);
    mintRealtimeToken.mockRejectedValueOnce(new Error("transient"));

    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.realtime.accessToken).toBeTruthy();
    expect(mintRealtimeToken).toHaveBeenCalledTimes(2);

    // The turn was never told it failed — the run stays exactly where a
    // normal successful dispatch leaves it.
    const run = await testDb.agentRun.findUniqueOrThrow({ where: { id: body.run.id } });
    expect(run.status).toBe("queued");
    expect(run.triggerRunId).toBeTruthy();
  });

  it("a persistent mint failure never reports a misleading failed-send — the run stays dispatched, not failed", async () => {
    const userId = "user_send_mint_fail";
    const chat = await createChatAs(userId);
    // Not mockRejectedValue (permanent) — resetTriggerMocks() only clears
    // call history, not implementation overrides, so a permanent override
    // here would leak into every later test in this file.
    mintRealtimeToken.mockRejectedValueOnce(new Error("still down"));
    mintRealtimeToken.mockRejectedValueOnce(new Error("still down"));

    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("REALTIME_UNAVAILABLE");
    // Must not read like the send itself failed — the user must not be
    // told to retry (that would duplicate an already-dispatched turn).
    expect(body.error.message.toLowerCase()).not.toContain("could not start");

    // The dispatch itself is untouched — no finalize, no second dispatch
    // attempt, exactly one AgentRun row still tracking the real trigger run.
    expect(dispatchAgentTurn).toHaveBeenCalledTimes(1);
    const runs = await testDb.agentRun.findMany({ where: { chatId: chat.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("queued");
    expect(runs[0].triggerRunId).toBeTruthy();
  });
});

describe("send turn — concurrent-send race", () => {
  it("exactly one of two simultaneous sends to the same chat succeeds; the other is rejected; exactly one AgentRun row exists", async () => {
    const userId = "user_send_race";
    const chat = await createChatAs(userId);

    const [a, b] = await Promise.all([
      sendReq(chat.id, userId, { content: [{ type: "text", text: "first" }] }),
      sendReq(chat.id, userId, { content: [{ type: "text", text: "second" }] }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const runs = await testDb.agentRun.findMany({ where: { chatId: chat.id } });
    expect(runs).toHaveLength(1);

    // The rejected request never dispatched a second turn.
    expect(dispatchAgentTurn).toHaveBeenCalledTimes(1);
  });
});
