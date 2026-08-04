import { describe, it, expect } from "vitest";
import { POST as createChat, GET as listChats } from "@/app/api/v1/chats/route";
import { POST as createMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";

const BASE = "http://localhost/api/v1/chats";
const USER = "user_search";

async function createChatAs(title: string) {
  const res = await createChat(authedRequest(BASE, USER, { method: "POST", body: JSON.stringify({ title }) }));
  return res.json();
}

async function sendMessage(chatId: string, text: string) {
  await createMessage(
    authedRequest(`${BASE}/${chatId}/messages`, USER, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
}

describe("search — title and message content", () => {
  it("matches a chat title substring", async () => {
    const chat = await createChatAs("Quarterly Roadmap Review");
    // listChats only surfaces chats with at least one message (see
    // services/chats.ts's `messages: { some: {} } }` filter) — a chatless
    // chat would never appear here regardless of title match.
    await sendMessage(chat.id, "kickoff");
    const res = await listChats(authedRequest(`${BASE}?q=roadmap`, USER));
    const body = await res.json();
    expect(body.items.map((c: { id: string }) => c.id)).toContain(chat.id);
  });

  it("matches a message-content substring when there's no title match", async () => {
    const chat = await createChatAs("Untitled");
    await sendMessage(chat.id, "let's talk about giraffes and their long necks");
    const res = await listChats(authedRequest(`${BASE}?q=giraffes`, USER));
    const body = await res.json();
    expect(body.items.map((c: { id: string }) => c.id)).toContain(chat.id);
  });

  it("a chat with many matching messages appears exactly once", async () => {
    const chat = await createChatAs("Repeats");
    await sendMessage(chat.id, "penguins are great");
    await sendMessage(chat.id, "penguins are also fast swimmers");
    await sendMessage(chat.id, "more about penguins here");
    const res = await listChats(authedRequest(`${BASE}?q=penguins`, USER));
    const body = await res.json();
    const matches = body.items.filter((c: { id: string }) => c.id === chat.id);
    expect(matches).toHaveLength(1);
  });

  it("a term matching nothing returns an empty page, not an error", async () => {
    const res = await listChats(authedRequest(`${BASE}?q=zzz_nonexistent_term_zzz`, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });
});
