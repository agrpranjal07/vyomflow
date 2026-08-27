import { describe, it, expect, beforeEach } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
import { vi } from "vitest";

import { POST as createChat } from "@/app/api/public/v1/chats/route";
import { POST as sendMessage } from "@/app/api/public/v1/chats/[chatId]/messages/route";
import { GET as getRun } from "@/app/api/public/v1/runs/[runId]/route";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";
import { RATE_LIMIT_MAX_SENDS } from "@/lib/config";

const CHATS_BASE = "http://localhost/api/public/v1/chats";

const WRITE_SCOPES = ["chats:write", "chats:read", "runs:write", "runs:read"];

function createChatAs(clerkUserId: string, scopes: string[] = WRITE_SCOPES) {
  return createChat(
    authedRequest(CHATS_BASE, clerkUserId, { method: "POST", body: JSON.stringify({ title: "Chat" }), scopes }),
  ).then((res) => res.json());
}

function sendReq(chatId: string, clerkUserId: string, body: unknown, opts: { scopes?: string[]; idempotencyKey?: string } = {}) {
  const { scopes = WRITE_SCOPES, idempotencyKey } = opts;
  return sendMessage(
    authedRequest(`${CHATS_BASE}/${chatId}/messages`, clerkUserId, {
      method: "POST",
      body: JSON.stringify(body),
      scopes,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    }),
    { params: Promise.resolve({ chatId }) },
  );
}

beforeEach(() => resetTriggerMocks());

describe("public API — auth and scopes", () => {
  it("rejects an anonymous request with 401 and public CORS headers", async () => {
    const res = await createChat(anonymousRequest(CHATS_BASE, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects a request with valid credentials but a missing scope with 403, not 401", async () => {
    const userId = "user_pub_scope_1";
    const res = await createChat(
      authedRequest(CHATS_BASE, userId, { method: "POST", body: JSON.stringify({}), scopes: ["runs:read"] }),
    );
    expect(res.status).toBe(403);
  });

  it("a session_token identity (no scopes array in the test convention) bypasses scope checks, matching requireScopes' own carve-out", async () => {
    const userId = "user_pub_session";
    const res = await createChat(authedRequest(CHATS_BASE, userId, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(201);
  });
});

describe("public API — ownership isolation", () => {
  it("a foreign api-key caller gets 404, never 403, for another user's chat", async () => {
    const owner = "user_pub_owner";
    const attacker = "user_pub_attacker";
    const chat = await createChatAs(owner);

    const res = await sendReq(chat.id, attacker, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(404);
  });
});

describe("public API — send-turn response shape", () => {
  it("never returns realtime.accessToken/streamKey, and returns a stream pointer instead", async () => {
    const userId = "user_pub_shape";
    const chat = await createChatAs(userId);
    const res = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.realtime).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("accessToken");
    expect(JSON.stringify(body)).not.toContain("streamKey");
    expect(body.stream.url).toContain(`/runs/${body.run.id}/stream`);
    expect(body.stream.fromIndex).toBe(0);
  });
});

describe("public API — Idempotency-Key replay", () => {
  it("a retried send with the same Idempotency-Key returns the original turn, charging credits once", async () => {
    const userId = "user_pub_idem";
    const chat = await createChatAs(userId);

    const first = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] }, { idempotencyKey: "retry-key-1" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const balanceAfterFirst = await testDb.creditHold.count({ where: { runId: firstBody.run.id } });
    expect(balanceAfterFirst).toBe(1);

    const second = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] }, { idempotencyKey: "retry-key-1" });
    expect(second.status).toBe(201);
    const secondBody = await second.json();

    // Same run/message replayed back — no second AgentRun row, no second hold.
    expect(secondBody.run.id).toBe(firstBody.run.id);
    expect(secondBody.message.id).toBe(firstBody.message.id);
    const runsForChat = await testDb.agentRun.count({ where: { chatId: chat.id } });
    expect(runsForChat).toBe(1);
    const holdsForRun = await testDb.creditHold.count({ where: { runId: firstBody.run.id } });
    expect(holdsForRun).toBe(1);
  });

  it("a different Idempotency-Key on the same chat is rejected as a normal active-run conflict, not silently merged", async () => {
    const userId = "user_pub_idem_2";
    const chat = await createChatAs(userId);

    const first = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] }, { idempotencyKey: "key-a" });
    expect(first.status).toBe(201);

    const second = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] }, { idempotencyKey: "key-b" });
    // Prior run is still `queued` (an active run) — a genuinely new send
    // conflicts exactly like the internal route's own active-run guard.
    expect(second.status).toBe(409);
  });
});

describe("public API — per-key rate limiting", () => {
  it("429s past the configured threshold with X-RateLimit-* and Retry-After headers", async () => {
    const userId = "user_pub_rate";
    const chat = await createChatAs(userId);

    let last;
    for (let i = 0; i < RATE_LIMIT_MAX_SENDS; i++) {
      last = await sendReq(chat.id, userId, { content: [{ type: "text", text: `hi ${i}` }] }, { idempotencyKey: `rl-${i}` });
    }
    expect(last?.status).not.toBe(429);

    const overLimit = await sendReq(chat.id, userId, { content: [{ type: "text", text: "over" }] }, { idempotencyKey: "rl-over" });
    expect(overLimit.status).toBe(429);
    expect(overLimit.headers.get("X-RateLimit-Limit")).toBe(String(RATE_LIMIT_MAX_SENDS));
    expect(overLimit.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(overLimit.headers.get("Retry-After")).toBeTruthy();
    expect(overLimit.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("two API keys belonging to the same user throttle independently", async () => {
    const userId = "user_pub_rate_two_keys";
    const chatA = await createChatAs(userId);
    const chatB = await createChatAs(userId);

    for (let i = 0; i < RATE_LIMIT_MAX_SENDS; i++) {
      const res = await sendMessage(
        authedRequest(`${CHATS_BASE}/${chatA.id}/messages`, userId, {
          method: "POST",
          body: JSON.stringify({ content: [{ type: "text", text: `hi ${i}` }] }),
          scopes: WRITE_SCOPES,
          apiKeyId: "key-A",
          headers: { "Idempotency-Key": `key-a-${i}` },
        }),
        { params: Promise.resolve({ chatId: chatA.id }) },
      );
      expect(res.status).not.toBe(429);
    }
    const keyAOverLimit = await sendMessage(
      authedRequest(`${CHATS_BASE}/${chatA.id}/messages`, userId, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "over" }] }),
        scopes: WRITE_SCOPES,
        apiKeyId: "key-A",
        headers: { "Idempotency-Key": "key-a-over" },
      }),
      { params: Promise.resolve({ chatId: chatA.id }) },
    );
    expect(keyAOverLimit.status).toBe(429);

    // key-B, same clerkUserId, untouched bucket — must not inherit key-A's exhaustion.
    const keyBRes = await sendMessage(
      authedRequest(`${CHATS_BASE}/${chatB.id}/messages`, userId, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
        scopes: WRITE_SCOPES,
        apiKeyId: "key-B",
        headers: { "Idempotency-Key": "key-b-1" },
      }),
      { params: Promise.resolve({ chatId: chatB.id }) },
    );
    expect(keyBRes.status).not.toBe(429);
  });
});

describe("public API — GET run public CORS", () => {
  it("returns public CORS headers on a run read", async () => {
    const userId = "user_pub_get_run";
    const chat = await createChatAs(userId);
    const sendRes = await sendReq(chat.id, userId, { content: [{ type: "text", text: "hi" }] });
    const sent = await sendRes.json();

    const res = await getRun(
      authedRequest(`http://localhost/api/public/v1/runs/${sent.run.id}`, userId, { scopes: ["runs:read"] }),
      { params: Promise.resolve({ runId: sent.run.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
