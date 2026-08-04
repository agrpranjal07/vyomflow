import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// Mirrors tool-orchestration.test.ts — buildSystemPromptContent always
// composes the skill roster, but no test here cares about skill content.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite } = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  streamWrite: vi.fn(),
}));
vi.mock("@/server/agent/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agent/loop")>();
  return { ...actual, runAgentLoop };
});
vi.mock("@/trigger/streams", () => ({
  assistantStream: {
    writer: (opts: { execute: (arg: { write: (part: unknown) => void }) => Promise<void> }) => ({
      waitUntilComplete: () => opts.execute({ write: streamWrite }),
    }),
  },
}));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { POST as respondWaitpoint } from "@/app/api/v1/waitpoints/[waitpointId]/respond/route";
import { executeAgentTurn } from "@/trigger/turn";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";
import { wait } from "@trigger.dev/sdk";
import { ASK_USER_TOOL_NAME } from "@/contracts/tools";
import type { ResolvedToolCall, RunAgentLoopParams } from "@/server/agent/loop";

const CHATS_BASE = "http://localhost/api/v1/chats";
const WAITPOINTS_BASE = "http://localhost/api/v1/waitpoints";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(CHATS_BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

async function sendAs(userId: string, chatId: string, text = "hello") {
  const res = await sendMessage(
    authedRequest(`${CHATS_BASE}/${chatId}/messages`, userId, {
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

function respondAs(userId: string, waitpointId: string, body: unknown) {
  return respondWaitpoint(
    authedRequest(`${WAITPOINTS_BASE}/${waitpointId}/respond`, userId, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ waitpointId }) },
  );
}

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
});

describe("waitpoints — respond route idempotency (C17, T31)", () => {
  it("a duplicate respond is a no-op 200: the first answer wins and the row is already COMPLETED for the second call", async () => {
    const userId = "user_waitpoint_dup_1";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const waitpoint = await testDb.waitpoint.create({
      data: {
        agentRunId: run.id,
        kind: "CREDIT_APPROVAL",
        requestPayload: { toolName: "crop_image", estimatedCredits: 0.1, threshold: 0.08 },
        triggerTokenId: `wpt_dup_${run.id}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const first = await respondAs(userId, waitpoint.id, { kind: "CREDIT_APPROVAL", approved: true });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.status).toBe("COMPLETED");
    expect(firstBody.resolvedPayload.approved).toBe(true);

    const rowAfterFirst = await testDb.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(rowAfterFirst.status).toBe("COMPLETED");

    // Second POST disagrees with the first answer — must still be a no-op
    // 200 that returns the FIRST answer, never re-mutating the row.
    const second = await respondAs(userId, waitpoint.id, { kind: "CREDIT_APPROVAL", approved: false });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.resolvedPayload.approved).toBe(true); // first answer still wins

    const rowAfterSecond = await testDb.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(rowAfterSecond.status).toBe("COMPLETED");
    expect((rowAfterSecond.resolvedPayload as { approved: boolean }).approved).toBe(true);
    expect(rowAfterSecond.resolvedAt?.getTime()).toBe(rowAfterFirst.resolvedAt?.getTime());
  });

  it("is idempotent for CLARIFICATION waitpoints too, and rejects a mismatched-kind body before ever mutating the row", async () => {
    const userId = "user_waitpoint_dup_2";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const waitpoint = await testDb.waitpoint.create({
      data: {
        agentRunId: run.id,
        kind: "CLARIFICATION",
        requestPayload: { question: "Which file?" },
        triggerTokenId: `wpt_dup_clar_${run.id}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const first = await respondAs(userId, waitpoint.id, { kind: "CLARIFICATION", answer: "the first one" });
    expect(first.status).toBe(200);

    const second = await respondAs(userId, waitpoint.id, { kind: "CLARIFICATION", answer: "the second one" });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.resolvedPayload.answer).toBe("the first one");
  });
});

describe("ask_user / CLARIFICATION — dispatch -> waiting -> respond -> resume (T33)", () => {
  it("suspends on a CLARIFICATION waitpoint for a free-text question, resumes with the respond route's answer", async () => {
    const userId = "user_waitpoint_ask_text";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id, "should I crop or resize?");
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    const ASK_CALL: ResolvedToolCall = {
      id: "call_ask_text",
      name: ASK_USER_TOOL_NAME,
      args: { question: "Which action do you want?" },
    };

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([ASK_CALL], 0)) ?? [];
      await params.onDelta({ index: 0, delta: "Got it." });
      return {
        outcome: "completed" as const,
        text: "Got it.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: results,
      };
    });

    // Real suspend/resume, via the real respond route — mirrors what a real
    // user response looks like: forToken (the mocked SDK primitive) resolves
    // only after the respond route has actually written the answer.
    wait.forToken = vi.fn(async (tokenId: string) => {
      const wp = await testDb.waitpoint.findFirstOrThrow({ where: { triggerTokenId: tokenId } });
      expect(wp.status).toBe("PENDING");
      const res = await respondAs(userId, wp.id, { kind: "CLARIFICATION", answer: "crop it" });
      expect(res.status).toBe(200);
      return { ok: true, output: {} };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_waitpoint_text"));

    const waitpoint = await testDb.waitpoint.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(waitpoint.kind).toBe("CLARIFICATION");
    expect(waitpoint.status).toBe("COMPLETED");
    expect((waitpoint.resolvedPayload as { answer: string }).answer).toBe("crop it");

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed");

    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; output?: { answer?: string }; name?: string }>;
    const toolUse = blocks.find((b) => b.type === "tool_use")!;
    expect(toolUse.name).toBe(ASK_USER_TOOL_NAME);
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.output?.answer).toBe("crop it");

    const waitpointParts = streamWrite.mock.calls.map(([part]) => part).filter((p: { type: string }) => p.type === "waitpoint");
    expect(waitpointParts).toHaveLength(1);
  });

  it("suspends on a CLARIFICATION waitpoint carrying multiple-choice options, resumes with the chosen option as the answer", async () => {
    const userId = "user_waitpoint_ask_options";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id, "which format?");
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    const OPTIONS = ["png", "jpg", "webp"];
    const ASK_CALL: ResolvedToolCall = {
      id: "call_ask_options",
      name: ASK_USER_TOOL_NAME,
      args: { question: "Which output format do you want?", options: OPTIONS },
    };

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([ASK_CALL], 0)) ?? [];
      await params.onDelta({ index: 0, delta: "Okay." });
      return {
        outcome: "completed" as const,
        text: "Okay.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: results,
      };
    });

    wait.forToken = vi.fn(async (tokenId: string) => {
      const wp = await testDb.waitpoint.findFirstOrThrow({ where: { triggerTokenId: tokenId } });
      expect((wp.requestPayload as { options?: string[] }).options).toEqual(OPTIONS);
      const res = await respondAs(userId, wp.id, { kind: "CLARIFICATION", answer: "webp" });
      expect(res.status).toBe(200);
      return { ok: true, output: {} };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_waitpoint_options"));

    const waitpoint = await testDb.waitpoint.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(waitpoint.status).toBe("COMPLETED");
    expect((waitpoint.requestPayload as { options?: string[] }).options).toEqual(OPTIONS);
    expect((waitpoint.resolvedPayload as { answer: string }).answer).toBe("webp");

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed");

    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; output?: { answer?: string } }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.output?.answer).toBe("webp");
  });
});
