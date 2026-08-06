import { describe, it, expect } from "vitest";
import { POST as createChat, GET as listChats } from "@/app/api/v1/chats/route";
import { GET as getChat, DELETE as deleteChat } from "@/app/api/v1/chats/[chatId]/route";
import { authedRequest, anonymousRequest } from "../support/request";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(clerkUserId: string, title = "Test chat") {
  const res = await createChat(authedRequest(BASE, clerkUserId, { method: "POST", body: JSON.stringify({ title }) }));
  return res.json();
}

describe("chat ownership — non-leaking 404 parity", () => {
  it("returns byte-identical 404s for a foreign chat, a never-existed id, and a soft-deleted chat", async () => {
    const owner = "user_owner";
    const other = "user_other";

    const chat = await createChatAs(owner);

    const foreignRes = await getChat(authedRequest(`${BASE}/${chat.id}`, other), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    const neverExistedRes = await getChat(authedRequest(`${BASE}/does-not-exist`, owner), {
      params: Promise.resolve({ chatId: "does-not-exist" }),
    });

    const referenceBody = await neverExistedRes.text();
    expect(foreignRes.status).toBe(404);
    expect(neverExistedRes.status).toBe(404);
    expect(await foreignRes.text()).toBe(referenceBody);

    // Now soft-delete as the real owner and re-check as the owner.
    const delRes = await deleteChat(authedRequest(`${BASE}/${chat.id}`, owner, { method: "DELETE" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(delRes.status).toBe(204);

    const deletedRes = await getChat(authedRequest(`${BASE}/${chat.id}`, owner), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(deletedRes.status).toBe(404);
    expect(await deletedRes.text()).toBe(referenceBody);
  });

  it("never returns another user's chat from search, even on an exact content match", async () => {
    const owner = "user_owner_2";
    const attacker = "user_attacker";
    await createChatAs(owner, "Owner's private chat about unicorns");

    const res = await listChats(authedRequest(`${BASE}?q=unicorns`, attacker));
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("repeated DELETE is idempotent — same non-leaking 404 as a never-existed chat, never a 500", async () => {
    const owner = "user_owner_3";
    const chat = await createChatAs(owner);

    const first = await deleteChat(authedRequest(`${BASE}/${chat.id}`, owner, { method: "DELETE" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(first.status).toBe(204);

    const second = await deleteChat(authedRequest(`${BASE}/${chat.id}`, owner, { method: "DELETE" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(second.status).toBe(404);

    const foreignAttempt = await deleteChat(authedRequest(`${BASE}/${chat.id}`, "user_ownership_someone_else", { method: "DELETE" }), {
      params: Promise.resolve({ chatId: chat.id }),
    });
    expect(foreignAttempt.status).toBe(404);
    expect(await foreignAttempt.text()).toBe(await second.text());
  });

  it("rejects unauthenticated requests with 401, not a redirect", async () => {
    const res = await listChats(anonymousRequest(BASE));
    expect(res.status).toBe(401);
  });
});
