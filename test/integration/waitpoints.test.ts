import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// Mirrors tool-orchestration.test.ts — buildSystemPromptContent always
// composes the skill roster, but no test here cares about skill content.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite, triggerAndWait, batchTriggerAndWait } = vi.hoisted(() => {
  const triggerAndWaitFn = vi.fn();
  return {
    runAgentLoop: vi.fn(),
    streamWrite: vi.fn(),
    triggerAndWait: triggerAndWaitFn,
    // Same batchTriggerAndWait shim as tool-orchestration.test.ts — turn.ts's
    // round dispatch (2026-08-29) always goes through mediaTool.
    // batchTriggerAndWait, never per-call triggerAndWait, so this must be
    // present or `mediaTool.batchTriggerAndWait` is undefined for every
    // CREDIT_APPROVAL test below that reaches an actual tool dispatch.
    batchTriggerAndWait: vi.fn(async (items: { payload: unknown; options?: unknown }[]) => ({
      runs: await Promise.all(items.map((item) => triggerAndWaitFn(item.payload, item.options))),
    })),
  };
});
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
vi.mock("@/trigger/tool", () => ({ mediaTool: { triggerAndWait, batchTriggerAndWait } }));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { POST as respondWaitpoint } from "@/app/api/v1/waitpoints/[waitpointId]/respond/route";
import { executeAgentTurn } from "@/trigger/turn";
import { createWaitpoint } from "@/services/waitpoints";
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

// Mirrors tool-orchestration.test.ts's registerOwnedAsset — crop_image's
// image_url must be a registered READY attachment for this chat, or turn.ts's
// URL allowlist rejects it before the credit-approval gate is ever reached.
async function registerOwnedAsset(ownerId: string, chatId: string, url: string) {
  await testDb.attachment.create({
    data: { chatId, ownerId, orderIndex: 0, status: "READY", resultUrl: url },
  });
}

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
  triggerAndWait.mockReset();
  // mockClear, not mockReset — must keep the default triggerAndWait-
  // delegating implementation set once in vi.hoisted above (see
  // tool-orchestration.test.ts's identical comment).
  batchTriggerAndWait.mockClear();
  // Reset call history left over from a prior test's override — `wait` is
  // the shared trigger-sdk-mock module object, so a previous test's
  // `wait.forToken = vi.fn(...)` assignment (and its call log) would
  // otherwise leak into the next test's `not.toHaveBeenCalled()` assertions.
  wait.forToken = vi.fn(() => Promise.resolve({ ok: true, output: {} }));
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
        requestPayload: { calls: [{ toolCallId: "call_1", toolName: "crop_image", estimatedCredits: 0.1 }], estimatedCredits: 0.1, threshold: 0.08 },
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

describe("CREDIT_APPROVAL — round-level waitpoint (2026-08-29 fix)", () => {
  const GENERATE_CALL_1: ResolvedToolCall = { id: "call_gen_1", name: "generate_image", args: { prompt: "a cat" } };
  const GENERATE_CALL_2: ResolvedToolCall = { id: "call_gen_2", name: "generate_image", args: { prompt: "a dog" } };
  const CROP_CALL: ResolvedToolCall = {
    id: "call_crop_1",
    name: "crop_image",
    args: { image_url: "https://example.com/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 },
  };

  // Auto-approves/declines every CREDIT_APPROVAL waitpoint via the real
  // respond route (not by writing the DB directly), so `wait.forToken`
  // resumes turn.ts only after the same product code path a real user
  // response goes through has actually run — mirrors the ask_user tests
  // above and tool-orchestration.test.ts's own `wait.forToken` override.
  function autoRespond(userId: string, approved: boolean) {
    wait.forToken = vi.fn(async (tokenId: string) => {
      const wp = await testDb.waitpoint.findFirstOrThrow({ where: { triggerTokenId: tokenId } });
      expect(wp.status).toBe("PENDING");
      const res = await respondAs(userId, wp.id, { kind: "CREDIT_APPROVAL", approved });
      expect(res.status).toBe(200);
      return { ok: true, output: {} };
    });
  }

  function mockDispatchCompleted(resultUrl: string) {
    triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: [resultUrl], creditUsed: 0.1, finishedAt: new Date() },
      });
      return { ok: true, output: { status: "COMPLETED", resultUrls: [resultUrl], creditUsedApp: 0.1, durationMs: 10 } };
    });
  }

  it("approves a tool once — the same tool in a later round of the same run is never re-prompted", async () => {
    const userId = "user_credit_approval_1";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    autoRespond(userId, true);
    mockDispatchCompleted("https://out.example.com/gen1.png");
    mockDispatchCompleted("https://out.example.com/gen2.png");

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const round1 = (await params.onToolCalls?.([GENERATE_CALL_1], 0)) ?? [];
      const round2 = (await params.onToolCalls?.([GENERATE_CALL_2], 1)) ?? [];
      await params.onDelta({ index: 0, delta: "done." });
      return {
        outcome: "completed" as const,
        text: "done.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: [...round1, ...round2],
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_credit_approval_1"));

    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);
    expect(waitpoints[0].status).toBe("COMPLETED");
    expect((waitpoints[0].requestPayload as { calls: { toolName: string }[] }).calls.map((c) => c.toolName)).toEqual(["generate_image"]);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { turnIndex: "asc" } });
    expect(invocations).toHaveLength(2);
    expect(invocations.map((i) => i.status)).toEqual(["COMPLETED", "COMPLETED"]);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed");
  });

  it("declines a tool once — the same tool keeps failing without any new waitpoint or ToolInvocation row", async () => {
    const userId = "user_credit_approval_2";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    autoRespond(userId, false);

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const round1 = (await params.onToolCalls?.([GENERATE_CALL_1], 0)) ?? [];
      const round2 = (await params.onToolCalls?.([GENERATE_CALL_2], 1)) ?? [];
      await params.onDelta({ index: 0, delta: "done." });
      return {
        outcome: "completed" as const,
        text: "done.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: [...round1, ...round2],
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_credit_approval_2"));

    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);
    expect(waitpoints[0].status).toBe("COMPLETED");
    expect((waitpoints[0].resolvedPayload as { approved: boolean }).approved).toBe(false);

    expect(triggerAndWait).not.toHaveBeenCalled();
    // A declined-and-remembered call never reaches ToolInvocation row
    // creation — the consent check fails it before that (turn.ts's
    // failWithoutInvocation path).
    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; toolUseId?: string; errorMessage?: string }>;
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((b) => b.errorMessage)).toEqual([
      "The user did not approve this action.",
      "The user did not approve this action.",
    ]);

    expect(finalRun.status).toBe("completed");
  });

  it("a second, never-before-seen tool in a later round still raises its own waitpoint, listing only that tool", async () => {
    const userId = "user_credit_approval_3";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    autoRespond(userId, true);
    mockDispatchCompleted("https://out.example.com/gen1.png");
    mockDispatchCompleted("https://out.example.com/cropped.png");

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const round1 = (await params.onToolCalls?.([GENERATE_CALL_1], 0)) ?? [];
      const round2 = (await params.onToolCalls?.([CROP_CALL], 1)) ?? [];
      await params.onDelta({ index: 0, delta: "done." });
      return {
        outcome: "completed" as const,
        text: "done.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: [...round1, ...round2],
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_credit_approval_3"));

    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id }, orderBy: { createdAt: "asc" } });
    expect(waitpoints).toHaveLength(2);
    expect((waitpoints[0].requestPayload as { calls: { toolName: string }[] }).calls.map((c) => c.toolName)).toEqual(["generate_image"]);
    expect((waitpoints[1].requestPayload as { calls: { toolName: string }[] }).calls.map((c) => c.toolName)).toEqual(["crop_image"]);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(2);
    expect(invocations.map((i) => i.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("an EXPIRED CREDIT_APPROVAL waitpoint counts as a decision — no re-prompt, immediate failure", async () => {
    const userId = "user_credit_approval_4";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    await testDb.waitpoint.create({
      data: {
        agentRunId: run.id,
        kind: "CREDIT_APPROVAL",
        status: "EXPIRED",
        requestPayload: { calls: [{ toolCallId: "x", toolName: "generate_image", estimatedCredits: 0.1 }], estimatedCredits: 0.1, threshold: 0.08 },
        triggerTokenId: `wpt_expired_${run.id}`,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([GENERATE_CALL_1], 0)) ?? [];
      await params.onDelta({ index: 0, delta: "done." });
      return {
        outcome: "completed" as const,
        text: "done.",
        chunkCount: 1,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: results,
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_credit_approval_4"));

    // Still just the one pre-seeded EXPIRED row — no new waitpoint raised.
    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);
    expect(waitpoints[0].status).toBe("EXPIRED");
    expect(wait.forToken).not.toHaveBeenCalled();
    expect(triggerAndWait).not.toHaveBeenCalled();
    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; errorMessage?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.errorMessage).toBe("The user did not approve this action.");
  });

  it("createWaitpoint is idempotent on triggerTokenId — a duplicate call is a no-op, not a P2002 throw", async () => {
    const userId = "user_credit_approval_5";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    const triggerTokenId = `wpt_idempotency_${run.id}`;
    const requestPayload = { calls: [{ toolCallId: "call_x", toolName: "generate_image", estimatedCredits: 0.1 }], estimatedCredits: 0.1, threshold: 0.08 };
    const expiresAt = new Date(Date.now() + 60_000);

    const createOnce = () =>
      testDb.$transaction((tx) =>
        createWaitpoint(tx, { runId: run.id, kind: "CREDIT_APPROVAL", requestPayload, triggerTokenId, expiresAt }),
      );

    const first = await createOnce();
    await expect(createOnce()).resolves.toEqual(first); // must not throw P2002 on the duplicate triggerTokenId
    const rows = await testDb.waitpoint.findMany({ where: { triggerTokenId } });
    expect(rows).toHaveLength(1);
  });
});
