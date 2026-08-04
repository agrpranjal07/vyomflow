import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { PATCH as renameChat, GET as getChat } from "@/app/api/v1/chats/[chatId]/route";
import { POST as createMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/chats";
const USER = "user_rename";

async function createChatAs(title?: string) {
  const res = await createChat(
    authedRequest(BASE, USER, { method: "POST", body: JSON.stringify(title ? { title } : {}) }),
  );
  return res.json();
}

describe("PATCH /chats/:chatId — rename", () => {
  it("renames an owned chat and returns the updated DTO", async () => {
    const chat = await createChatAs("New chat");
    const res = await renameChat(
      authedRequest(`${BASE}/${chat.id}`, USER, { method: "PATCH", body: JSON.stringify({ title: "  My renamed chat  " }) }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("My renamed chat");

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    expect((await getRes.json()).title).toBe("My renamed chat");
  });

  it("rejects an empty/whitespace-only title with 400", async () => {
    const chat = await createChatAs();
    const res = await renameChat(
      authedRequest(`${BASE}/${chat.id}`, USER, { method: "PATCH", body: JSON.stringify({ title: "   " }) }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns the same non-leaking 404 for a foreign chat as GET/DELETE", async () => {
    const chat = await createChatAs();
    const res = await renameChat(
      authedRequest(`${BASE}/${chat.id}`, "user_someone_else", { method: "PATCH", body: JSON.stringify({ title: "nope" }) }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("404s on a never-existed chat id", async () => {
    const res = await renameChat(
      authedRequest(`${BASE}/does-not-exist`, USER, { method: "PATCH", body: JSON.stringify({ title: "x" }) }),
      { params: Promise.resolve({ chatId: "does-not-exist" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("auto-title from first prompt", () => {
  it("derives a title from the first message when the chat still has the default title", async () => {
    const chat = await createChatAs();
    expect(chat.title).toBe("New chat");

    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "  write a poem about   the ocean  " }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    const body = await getRes.json();
    expect(body.title).toBe("write a poem about the ocean");
  });

  it("truncates a long first message with a trailing ellipsis", async () => {
    const chat = await createChatAs();
    const longText = "x".repeat(120);

    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: longText }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    const body = await getRes.json();
    expect(body.title.length).toBeLessThanOrEqual(61);
    expect(body.title.endsWith("…")).toBe(true);
  });

  it("never overwrites a title the chat was explicitly created with", async () => {
    const chat = await createChatAs("Explicit title");

    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "some first message" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    expect((await getRes.json()).title).toBe("Explicit title");
  });

  it("never overwrites a title set by a rename that lands before the first message is sent", async () => {
    const chat = await createChatAs();
    await renameChat(
      authedRequest(`${BASE}/${chat.id}`, USER, { method: "PATCH", body: JSON.stringify({ title: "Renamed before send" }) }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "some first message" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    expect((await getRes.json()).title).toBe("Renamed before send");
  });

  it("does not retitle on a second message once the first already set a real title", async () => {
    const chat = await createChatAs();
    const firstRes = await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "first message sets the title" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    // S2's one-active-run-per-chat invariant blocks a second send while the
    // first run is still queued — finalize it first (see pin-and-messages.test.ts).
    const { run } = await firstRes.json();
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "completed" } });

    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "second message should not retitle" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );

    const getRes = await getChat(authedRequest(`${BASE}/${chat.id}`, USER), { params: Promise.resolve({ chatId: chat.id }) });
    expect((await getRes.json()).title).toBe("first message sets the title");
  });
});
