/**
 * Wire-level check for S4 multimodal serialization: requestOpenRouterCompletion
 * forwards `OpenRouterMessage.content` (string | OpenRouterContentPart[])
 * verbatim into the real JSON request body — asserted here against the
 * actual body OpenRouter would receive, not just the in-process message
 * array conversation.test.ts builds. No DB involved (this module makes no
 * Prisma calls), so no truncateAll/setup dependency.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from "vitest";
import { requestOpenRouterCompletion } from "@/server/openrouter/client";
import { openRouterServer, openRouterCapturingStreamHandler } from "../support/msw-openrouter";

beforeAll(() => openRouterServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => openRouterServer.resetHandlers());
afterAll(() => openRouterServer.close());

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test_openrouter_key";
});

const MINIMAL_SSE = 'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

describe("requestOpenRouterCompletion — wire body carries multimodal content parts", () => {
  it("a message with an image_url content part reaches OpenRouter's real request body unchanged", async () => {
    const captured: unknown[] = [];
    openRouterServer.use(openRouterCapturingStreamHandler(MINIMAL_SSE, captured));

    await requestOpenRouterCompletion({
      model: "openrouter/free",
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } },
          ],
        },
      ],
    });

    expect(captured).toHaveLength(1);
    const body = captured[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } },
    ]);
  });

  it("a plain-string content message is still sent as a plain string, not wrapped into an array", async () => {
    const captured: unknown[] = [];
    openRouterServer.use(openRouterCapturingStreamHandler(MINIMAL_SSE, captured));

    await requestOpenRouterCompletion({
      model: "openrouter/free",
      messages: [{ role: "user", content: "just text" }],
    });

    const body = captured[0] as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toBe("just text");
  });
});
