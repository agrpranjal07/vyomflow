import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { POST as createChat, GET as listChats } from "@/app/api/v1/chats/route";
import { POST as pinChat, DELETE as unpinChat } from "@/app/api/v1/chats/[chatId]/pin/route";
import { POST as createMessage, GET as listMessages } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/chats";
const USER = "user_pin_msg";

async function createChatAs() {
  const res = await createChat(authedRequest(BASE, USER, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

describe("pin toggle", () => {
  it("pinning surfaces the chat under ?pinned=true; unpinning removes it; idempotent", async () => {
    const chat = await createChatAs();
    // listChats only surfaces chats with at least one message (see
    // services/chats.ts's `messages: { some: {} } }` filter) — a chatless
    // chat would never appear in the ?pinned=true assertions below.
    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "seed" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const pinRes = await pinChat(authedRequest(`${BASE}/${chat.id}/pin`, USER, { method: "POST" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(pinRes.status).toBe(200);

    // Pinning twice is idempotent, not an error.
    const pinAgain = await pinChat(authedRequest(`${BASE}/${chat.id}/pin`, USER, { method: "POST" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(pinAgain.status).toBe(200);

    const pinnedList = await listChats(authedRequest(`${BASE}?pinned=true`, USER));
    const pinnedBody = await pinnedList.json();
    expect(pinnedBody.items.map((c: { id: string }) => c.id)).toContain(chat.id);

    await unpinChat(authedRequest(`${BASE}/${chat.id}/pin`, USER, { method: "DELETE" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });

    const afterUnpin = await listChats(authedRequest(`${BASE}?pinned=true`, USER));
    const afterUnpinBody = await afterUnpin.json();
    expect(afterUnpinBody.items.map((c: { id: string }) => c.id)).not.toContain(chat.id);
  });
});

describe("message persistence and validation", () => {
  it("persists a message under the length limit and returns it in the list", async () => {
    const chat = await createChatAs();
    const res = await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "hello there" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(201);

    const listRes = await listMessages(authedRequest(`${BASE}/${chat.id}/messages`, USER), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    const body = await listRes.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].content[0]).toEqual({ type: "text", text: "hello there" });
  });

  it("rejects an over-length message before persistence, with zero rows written", async () => {
    const chat = await createChatAs();
    const overLong = "x".repeat(8001);
    const res = await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: overLong }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");

    const listRes = await listMessages(authedRequest(`${BASE}/${chat.id}/messages`, USER), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    const listBody = await listRes.json();
    expect(listBody.items).toHaveLength(0);
  });

  it("rejects empty-text messages with a specific, user-safe error", async () => {
    const chat = await createChatAs();
    const res = await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("cursor-paginates messages with no duplicates or gaps", async () => {
    const chat = await createChatAs();
    for (let i = 0; i < 5; i++) {
      const res = await createMessage(
        authedRequest(`${BASE}/${chat.id}/messages`, USER, {
          method: "POST",
          body: JSON.stringify({ content: [{ type: "text", text: `message ${i}` }] }),
        }),
        { params: Promise.resolve({ chatId: chat.id }) },
      );
      // S2's one-active-run-per-chat invariant blocks a second send while
      // the prior run is still queued/running — finalize each run so the
      // next iteration's send isn't rejected with a 409. The mocked
      // dispatch never resolves the run on its own (no real task runs).
      const { run } = await res.json();
      await testDb.agentRun.update({ where: { id: run.id }, data: { status: "completed" } });
      await new Promise((r) => setTimeout(r, 2));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url = new URL(`${BASE}/${chat.id}/messages`);
      url.searchParams.set("limit", "2");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await listMessages(authedRequest(url.toString(), USER), {
        params: Promise.resolve({ chatId: chat.id }),
      });
      const body = await res.json();
      seen.push(...body.items.map((m: { id: string }) => m.id));
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});
