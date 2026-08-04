/**
 * S4: AGENT_SYSTEM_PROMPT is prepended as messages[0] at executeAgentTurn's
 * call site (src/trigger/turn.ts), deliberately NOT inside
 * buildConversationMessages itself (see conversation.ts's own tests, which
 * assert history-array shape only) — so it isn't reachable through
 * conversation.test.ts. Verified here the same way turn-retry.test.ts
 * verifies other turn.ts behavior: mock runAgentLoop and inspect the
 * `messages` array it was actually invoked with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// This suite asserts on the exact base system-prompt content (S4 behavior) — mock the skill
// roster to empty so buildSystemPromptContent()'s output equals AGENT_SYSTEM_PROMPT unchanged,
// without needing the cwd/chdir dance the skills-orchestration suite uses for real skill content.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite } = vi.hoisted(() => ({ runAgentLoop: vi.fn(), streamWrite: vi.fn() }));
vi.mock("@/server/agent/loop", () => ({ runAgentLoop }));
vi.mock("@/trigger/streams", () => ({
  assistantStream: {
    writer: (opts: { execute: (arg: { write: (part: unknown) => void }) => Promise<void> }) => ({
      waitUntilComplete: () => opts.execute({ write: streamWrite }),
    }),
  },
}));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { executeAgentTurn } from "@/trigger/turn";
import { AGENT_SYSTEM_PROMPT } from "@/server/agent/system-prompt";
import type { OpenRouterMessage } from "@/server/openrouter/client";
import { authedRequest } from "../support/request";
import { resetTriggerMocks } from "../support/trigger-mock";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

async function sendAs(userId: string, chatId: string, text = "hi") {
  const res = await sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
  return res.json();
}

function fakeCtx(triggerRunId: string) {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
});

describe("executeAgentTurn — system prompt prepending (S4)", () => {
  it("prepends AGENT_SYSTEM_PROMPT as messages[0] ahead of the built conversation history", async () => {
    const userId = "user_turn_sysprompt_1";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id, "hello there");
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId, requestedModel: run.requestedModel };

    let seenMessages: OpenRouterMessage[] | undefined;
    runAgentLoop.mockImplementationOnce(async (params: { messages: OpenRouterMessage[] }) => {
      seenMessages = params.messages;
      return {
        outcome: "completed" as const,
        text: "hi",
        reasoning: "",
        chunkCount: 0,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 1, completionTokens: 1, costCredits: 0 },
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_sysprompt_1"));

    expect(seenMessages).toBeDefined();
    expect(seenMessages![0]).toEqual({ role: "system", content: AGENT_SYSTEM_PROMPT });
    // The user's own turn message follows, not swallowed by the prepend.
    expect(seenMessages!.some((m) => m.role === "user" && m.content === "hello there")).toBe(true);
  });
});
