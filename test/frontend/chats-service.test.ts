import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { listChats, createChat } from "@/services/chats";
import type { Fetcher } from "@/lib/api-client";

const BACKEND = "http://localhost:3000";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Service modules take a Fetcher, not fetch directly — this mimics
// useApiClient's contract without needing a Clerk token in tests.
const fetcher: Fetcher = async (path, init) => {
  const res = await fetch(`${BACKEND}${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
};

describe("chats service — runtime validation", () => {
  it("parses a well-formed response into the expected shape", async () => {
    server.use(
      http.get(`${BACKEND}/api/v1/chats`, () =>
        HttpResponse.json({
          items: [{ id: "c1", title: "Hello", pinnedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
          nextCursor: null,
        }),
      ),
    );

    const page = await listChats(fetcher, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0].title).toBe("Hello");
  });

  it("throws on a malformed response instead of silently passing bad data through", async () => {
    server.use(
      http.get(`${BACKEND}/api/v1/chats`, () =>
        // Missing required fields (id, createdAt, updatedAt) and nextCursor.
        HttpResponse.json({ items: [{ title: "Hello" }] }),
      ),
    );

    await expect(listChats(fetcher, {})).rejects.toThrow();
  });

  it("throws when createChat's response is missing required fields", async () => {
    server.use(
      http.post(`${BACKEND}/api/v1/chats`, () => HttpResponse.json({ title: "Untitled" }, { status: 201 })),
    );

    await expect(createChat(fetcher, {})).rejects.toThrow();
  });
});
