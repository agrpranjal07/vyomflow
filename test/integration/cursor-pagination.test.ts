import { describe, it, expect } from "vitest";
import { POST as createChat, GET as listChats } from "@/app/api/v1/chats/route";
import { POST as pinChat } from "@/app/api/v1/chats/[chatId]/pin/route";
import { POST as createMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";

const BASE = "http://localhost/api/v1/chats";
const USER = "user_cursor";

async function seedChats(n: number, titlePrefix = "Chat") {
  const chats = [];
  for (let i = 0; i < n; i++) {
    const res = await createChat(authedRequest(BASE, USER, { method: "POST", body: JSON.stringify({ title: `${titlePrefix} ${i}` }) }));
    const chat = await res.json();
    // listChats only surfaces chats with at least one message (see
    // services/chats.ts's `messages: { some: {} } }` filter) — a chat
    // seeded with no message would never appear in these listing assertions.
    await createMessage(
      authedRequest(`${BASE}/${chat.id}/messages`, USER, {
        method: "POST",
        body: JSON.stringify({ content: [{ type: "text", text: "seed" }] }),
      }),
      { params: Promise.resolve({ chatId: chat.id }) },
    );
    chats.push(chat);
    // Ensure strictly increasing createdAt so ordering is deterministic even
    // at sub-millisecond seed speed.
    await new Promise((r) => setTimeout(r, 2));
  }
  return chats;
}

async function fetchAllPages(query: string, pageSize: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const url = new URL(BASE);
    if (query) new URLSearchParams(query).forEach((v, k) => url.searchParams.set(k, v));
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await listChats(authedRequest(url.toString(), USER));
    const body = await res.json();
    seen.push(...body.items.map((c: { id: string }) => c.id));
    cursor = body.nextCursor;
    guard += 1;
  } while (cursor && guard < 20);
  return seen;
}

describe("cursor pagination correctness across a page boundary", () => {
  it("unfiltered: no duplicates, no gaps", async () => {
    const seeded = await seedChats(7);
    const seen = await fetchAllPages("", 3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(seeded.map((c) => c.id)));
  });

  it("under q=: no duplicates, no gaps, narrows correctly", async () => {
    await seedChats(4, "Alpha");
    const matching = await seedChats(5, "Beta-match");
    const seen = await fetchAllPages("q=Beta-match", 2);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(matching.map((c) => c.id)));
  });

  it("under pinned=true: no duplicates, no gaps, filter not a re-order", async () => {
    const chats = await seedChats(6);
    // Pin every other chat.
    for (const chat of chats.filter((_, i) => i % 2 === 0)) {
      await pinChat(authedRequest(`${BASE}/${chat.id}/pin`, USER, { method: "POST" }), {
        params: Promise.resolve({ chatId: chat.id }),
      });
    }
    const seen = await fetchAllPages("pinned=true", 2);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(chats.filter((_, i) => i % 2 === 0).map((c) => c.id)));
  });
});
