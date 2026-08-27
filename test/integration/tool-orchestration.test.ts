import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// This suite doesn't care about skill content — avoid the cwd/chdir dance the skills-orchestration
// suite needs, since executeAgentTurn now always composes the skill roster into the system prompt.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite, triggerAndWait } = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  streamWrite: vi.fn(),
  triggerAndWait: vi.fn(),
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
vi.mock("@/trigger/tool", () => ({ mediaTool: { triggerAndWait } }));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { executeAgentTurn } from "@/trigger/turn";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";
import { wait } from "@trigger.dev/sdk";
import type { ResolvedToolCall, ToolExecutionResult, RunAgentLoopParams } from "@/server/agent/loop";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

// S4's URL allowlist (src/trigger/turn.ts's getAllowedAssetUrls, checked
// before any ToolInvocation row is created) rejects an image_url that isn't
// a registered owned asset for the chat — register CROP_CALL's URL as a
// READY, unbound-turned-owned attachment before dispatch, matching what any
// real caller must now do post-S4.
async function registerOwnedAsset(ownerId: string, chatId: string, url: string) {
  await testDb.attachment.create({
    data: { chatId, ownerId, orderIndex: 0, status: "READY", resultUrl: url },
  });
}

async function sendAs(userId: string, chatId: string) {
  const res = await sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "crop this please" }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
  return res.json();
}

function fakeCtx(triggerRunId: string) {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

const CROP_CALL: ResolvedToolCall = {
  id: "call_1",
  name: "crop_image",
  args: { image_url: "https://example.com/a.png", x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 50 },
};

/** Drives runAgentLoop's mock through exactly one tool round then a final text completion. */
function mockOneToolRound() {
  runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
    await params.onDelta({ index: 0, delta: "Cropping " });
    const results = (await params.onToolCalls?.([CROP_CALL], 0)) ?? [];
    await params.onDelta({ index: 1, delta: "done." });
    return {
      outcome: "completed" as const,
      text: "Cropping done.",
      chunkCount: 2,
      finishReason: "stop",
      resolvedModel: "upstage/solar-pro-3:free",
      usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
      toolResultsForAssertion: results,
    };
  });
}

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
  triggerAndWait.mockReset();
  // S6: crop_image's estimate (0.1) exceeds APPROVAL_CREDIT_THRESHOLD
  // (0.08) by design (.claude/specs/S6-reliability-implementation-plan.md
  // §7.1's config comment: chosen so at least one real tool crosses it),
  // so every dispatch in this suite now suspends on a CREDIT_APPROVAL
  // waitpoint first. This suite tests dispatch/credit-capture mechanics,
  // not the approval gate itself (see integration/waitpoints.test.ts for
  // that) — simulate a real approving user by resolving the waitpoint the
  // same way respondToWaitpoint does, directly in the DB, right before the
  // mocked forToken resumes turn.ts.
  wait.forToken = vi.fn(async (id: string) => {
    await testDb.waitpoint.updateMany({
      where: { triggerTokenId: id, status: "PENDING" },
      data: { status: "COMPLETED", resolvedPayload: { approved: true, respondedAt: new Date().toISOString() }, resolvedAt: new Date() },
    });
    return { ok: true, output: {} };
  });
});

describe("executeAgentTurn — tool orchestration", () => {
  it("dispatches a tool call, captures credit at the reported amount, and persists ordered tool_use/tool_result blocks", async () => {
    const userId = "user_tool_orch_1";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    // triggerAndWait is mocked — the real ToolInvocation status/result
    // transition is owned by src/trigger/tool.ts's own task body (tested
    // separately in integration/tool-execution.test.ts), so this mock
    // mirrors what that task would have durably persisted before
    // returning, the same way the real triggerAndWait resolves only after
    // the child task's own writes have landed.
    triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsed: 0.05, finishedAt: new Date() },
      });
      return {
        ok: true,
        output: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsedApp: 0.05, durationMs: 4321 },
      };
    });
    mockOneToolRound();

    await executeAgentTurn(payload, fakeCtx("trigger_tool_1"));

    const invocation = await testDb.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("COMPLETED");
    expect(invocation.name).toBe("crop_image");
    expect(Number(invocation.creditUsed)).toBeCloseTo(0.05, 6);
    expect(invocation.resultUrls).toEqual(["https://out.example.com/cropped.png"]);

    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(1);
    expect(captureRows[0].idempotencyKey).toBe(`capture:${invocation.id}`);

    const finalRunForMessage = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRunForMessage.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; text?: string; durationMs?: number }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "tool_result", "text", "usage"]);
    expect(blocks[0].text).toBe("Cropping ");
    expect(blocks[3].text).toBe("done.");
    // tool.ts's reported durationMs must reach the persisted tool_result
    // block, not just the DB row (audit: it was computed for markToolCompleted
    // but dropped from the child task's own return value).
    expect(blocks[2].durationMs).toBe(4321);

    const toolPartWrites = streamWrite.mock.calls.map(([part]) => part).filter((p: { type: string }) => p.type === "tool");
    expect(toolPartWrites.map((p: { status: string }) => p.status)).toEqual(["DISPATCHING", "COMPLETED"]);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed");
  });

  it("marks the ToolInvocation FAILED and settles insufficient credits without dispatching, when headroom runs out", async () => {
    const userId = "user_tool_orch_2";
    const chat = await createChatAs(userId);
    await testDb.user.update({ where: { clerkUserId: userId }, data: { creditBalance: 0.02 } });
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    mockOneToolRound();

    await executeAgentTurn(payload, fakeCtx("trigger_tool_2"));

    const invocation = await testDb.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("insufficient_credits");
    expect(triggerAndWait).not.toHaveBeenCalled();

    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(0);

    // Fails before the media-tool task ever runs — the persisted block must
    // still carry an explicit terminal status and a real (non-negative)
    // duration, never left undefined for the frontend to mis-default.
    const finalRunForMessage = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRunForMessage.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string; durationMs?: number }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.status).toBe("FAILED");
    expect(toolResult.durationMs).toBeGreaterThanOrEqual(0);

    // The tool stream part must carry errorCode, not just errorMessage, so
    // the frontend paywall can distinguish a credit failure from any other
    // tool failure without string-matching (see credit-paywall-dialog.tsx).
    const toolPartWrites = streamWrite.mock.calls.map(([part]) => part).filter((p: { type: string }) => p.type === "tool");
    const failedWrite = toolPartWrites.find((p: { status: string }) => p.status === "FAILED");
    expect(failedWrite?.errorCode).toBe("insufficient_credits");
  });

  it("marks the ToolInvocation FAILED on an engine-reported failure and still finishes the turn", async () => {
    const userId = "user_tool_orch_3";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    // Mirrors what tool.ts would durably persist when the sharp engine's
    // own `CropExtractError` is thrown from crop_image's execute() and
    // classified by classifyMediaToolError (src/server/tools/errors.ts).
    triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "FAILED", errorCode: "crop_failed", errorMessage: "The image could not be cropped. Please try again.", finishedAt: new Date() },
      });
      return {
        ok: true,
        output: {
          status: "FAILED",
          resultUrls: [],
          creditUsedApp: 0,
          errorCode: "crop_failed",
          errorMessage: "The image could not be cropped. Please try again.",
          durationMs: 987,
        },
      };
    });
    mockOneToolRound();

    await executeAgentTurn(payload, fakeCtx("trigger_tool_3"));

    const invocation = await testDb.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed"); // the assistant turn itself still completes; only the tool failed

    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; durationMs?: number }>;
    expect(blocks.find((b) => b.type === "tool_result")!.durationMs).toBe(987);
  });

  // Regression for the credit-capture-on-failure bug: turn.ts's capture gate
  // must key off output.status, not merely output.creditUsedApp > 0. tool.ts
  // itself never reports a positive creditUsedApp on a FAILED run (every
  // failure path in tool.ts returns 0) — this test drives dispatchOne's own
  // gate directly against a hostile/defensive input, so the invariant holds
  // even if a future adapter or task result regresses to reporting one.
  it("never captures credit for a FAILED tool run, even if the task result reports a positive creditUsedApp", async () => {
    const userId = "user_tool_orch_failed_billed";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "FAILED", errorCode: "asset_upload_failed", errorMessage: "The generated file could not be saved. Please try again.", finishedAt: new Date() },
      });
      return {
        ok: true,
        output: {
          status: "FAILED",
          resultUrls: [],
          creditUsedApp: 0.1, // hostile input: a FAILED result reporting a positive charge
          errorCode: "asset_upload_failed",
          errorMessage: "The generated file could not be saved. Please try again.",
          durationMs: 111,
        },
      };
    });
    mockOneToolRound();

    await executeAgentTurn(payload, fakeCtx("trigger_tool_failed_billed"));

    const invocation = await testDb.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");

    const captures = await testDb.creditLedger.findMany({ where: { toolInvocationId: invocation.id, kind: "CAPTURE" } });
    expect(captures).toHaveLength(0);
  });

  it("marks the ToolInvocation FAILED with an explicit status when the child task itself fails (not a provider-reported failure)", async () => {
    const userId = "user_tool_orch_4";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    // triggerAndWait resolving `{ ok: false }` (the child Trigger.dev task
    // itself failed/crashed) — distinct from a provider-reported FAILED
    // output, which resolves `{ ok: true, output: { status: "FAILED" } }`.
    triggerAndWait.mockImplementationOnce(async () => ({ ok: false }));
    mockOneToolRound();

    await executeAgentTurn(payload, fakeCtx("trigger_tool_4"));

    const invocation = await testDb.toolInvocation.findFirstOrThrow({ where: { agentRunId: run.id } });
    expect(invocation.status).toBe("FAILED");
    expect(invocation.errorCode).toBe("tool_task_failed");

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string; durationMs?: number }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.status).toBe("FAILED");
    expect(toolResult.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("persists a reasoning block positioned before the tool_use block it chronologically preceded (assignment §5 ordering)", async () => {
    const userId = "user_tool_orch_6";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsed: 0.05, finishedAt: new Date() },
      });
      return {
        ok: true,
        output: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsedApp: 0.05, durationMs: 100 },
      };
    });

    // Drives the loop exactly the way loop.ts would for a reasoning-capable
    // model: reasoning deltas arrive first (chronologically before the tool
    // call), then the tool round, then trailing text.
    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      await params.onReasoningDelta?.({ index: 0, delta: "Let me crop this image. " });
      const results = (await params.onToolCalls?.([CROP_CALL], 0)) ?? [];
      await params.onDelta({ index: 1, delta: "Done cropping." });
      return {
        outcome: "completed" as const,
        text: "Done cropping.",
        reasoning: "Let me crop this image. ",
        chunkCount: 2,
        finishReason: "stop",
        resolvedModel: "upstage/solar-pro-3:free",
        usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
        toolResultsForAssertion: results,
      };
    });

    await executeAgentTurn(payload, fakeCtx("trigger_tool_6"));

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; text?: string }>;

    // The assembler always seeds a leading empty text block (pre-existing
    // behavior, unrelated to reasoning) — the reasoning delta is the first
    // real event, so it opens its own block right after that empty seed.
    expect(blocks.map((b) => b.type)).toEqual(["text", "reasoning", "tool_use", "tool_result", "text", "usage"]);
    expect(blocks.find((b) => b.type === "reasoning")?.text).toBe("Let me crop this image. ");
    const reasoningIndex = blocks.findIndex((b) => b.type === "reasoning");
    const toolUseIndex = blocks.findIndex((b) => b.type === "tool_use");
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(toolUseIndex).toBeGreaterThan(reasoningIndex);
  });

  it("persists an explicit FAILED status (not left undefined) when the model calls an unregistered tool", async () => {
    const userId = "user_tool_orch_5";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    // No ToolInvocation row is ever created for this path — the frontend's
    // ToolCard previously defaulted an absent `status` to "running", which
    // left cards like this permanently spinning even though the call had
    // already failed validation before dispatch.
    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([{ id: "call_bad", name: "not_a_real_tool", args: {} }], 0)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_tool_5"));

    // No ToolInvocation row exists for this call — the only durable record
    // is the persisted tool_use/tool_result block pair.
    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.status).toBe("FAILED");
  });

  // Area-3 audit (turn.ts's dispatch order, ~L253-267): `tool.inputSchema.
  // safeParse` runs, and must fail, strictly before `estimateCredits`/the
  // ToolInvocation row/reserveAdditional/the tool dispatch — a registered
  // tool called with arguments that don't satisfy its Zod schema (crop_image
  // with no rectangle fields at all) must never reach credit reservation or
  // dispatch. Previously untested at the orchestration level (only the
  // adapter's schema itself was unit-tested in tool-adapters.test.ts).
  it("rejects a registered tool call with arguments that fail its schema, before reserving credit or dispatching", async () => {
    const userId = "user_tool_orch_malformed";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, "https://example.com/a.png");

    // Registered tool, owned URL, but no percent/pixel rectangle at all —
    // fails crop_image's own superRefine, so this must never get past
    // safeParse regardless of the URL allowlist passing.
    const MALFORMED_CALL: ResolvedToolCall = { id: "call_malformed", name: "crop_image", args: { image_url: "https://example.com/a.png" } };

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([MALFORMED_CALL], 0)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_tool_malformed"));

    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);
    expect(triggerAndWait).not.toHaveBeenCalled();

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string; errorMessage?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.status).toBe("FAILED");
    expect(toolResult.errorMessage).toBe("The tool call's arguments did not match its expected shape.");
  });

  // S4/S6 audit (turn.ts's getAllowedAssetUrls/extractCandidateUrls, ~L157-384):
  // a URL the model passes that this chat doesn't actually own (never
  // registered as a READY attachment or a prior ToolInvocation's own output)
  // must be rejected pre-dispatch — no ToolInvocation row, no credit hold,
  // no provider call. Previously untested: the exact error site the user-
  // reported "file not found" bug points at had zero coverage.
  it("rejects a tool call whose URL isn't an owned asset for this chat, before creating any ToolInvocation", async () => {
    const userId = "user_tool_orch_7";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    // Deliberately NOT calling registerOwnedAsset — CROP_CALL's image_url is
    // unregistered for this chat.

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([CROP_CALL], 0)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_tool_7"));

    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);
    expect(triggerAndWait).not.toHaveBeenCalled();

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string; errorMessage?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result")!;
    expect(toolResult.status).toBe("FAILED");
    expect(toolResult.errorMessage).toBe("One or more referenced files are not available in this chat.");
  });

  // S4/S6 audit — chained tool calls (upload -> crop -> crop again) must
  // keep working: a SECOND round's tool call referencing the FIRST round's
  // own resultUrl must be allowed, since getAllowedAssetUrls is re-queried
  // fresh (allowedUrlsPromise reset) at the start of every round, not just
  // once for the whole turn. Regression guard for the exact race
  // hypothesized during the attachment-threading audit (buildToolExecutor's
  // per-round memoization) — confirms it is NOT reachable as a bug.
  it("allows a second round's tool call to reference the first round's own tool output (cross-round chaining)", async () => {
    const userId = "user_tool_orch_8";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    const CROP_CALL_ROUND_2: ResolvedToolCall = {
      id: "call_round2",
      name: "crop_image",
      args: { image_url: "https://out.example.com/cropped.png", x_percent: 0, y_percent: 0, width_percent: 25, height_percent: 25 },
    };

    triggerAndWait
      .mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
        await testDb.toolInvocation.update({
          where: { id: toolInvocationId },
          data: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsed: 0.05, finishedAt: new Date() },
        });
        return {
          ok: true,
          output: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsedApp: 0.05, durationMs: 50 },
        };
      })
      .mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
        await testDb.toolInvocation.update({
          where: { id: toolInvocationId },
          data: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped2.png"], creditUsed: 0.05, finishedAt: new Date() },
        });
        return {
          ok: true,
          output: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped2.png"], creditUsedApp: 0.05, durationMs: 50 },
        };
      });

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const round1 = (await params.onToolCalls?.([CROP_CALL], 0)) ?? [];
      const round2 = (await params.onToolCalls?.([CROP_CALL_ROUND_2], 1)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_tool_8"));

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { turnIndex: "asc" } });
    expect(invocations).toHaveLength(2);
    expect(invocations.map((i) => i.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(invocations[1].errorMessage).toBeNull();
  });

  // testing-policy.md's lifecycle-transition requirement: a repeated
  // transition within one turn, across two different in-process engines
  // (generate_image -> cloudflare, crop_image -> sharp), must not leak
  // state between the two ToolInvocation rows or their credit holds.
  // (workDir isolation itself — each invocation gets its own mkdtemp'd
  // dir, cleaned up in tool.ts's own `finally` — is exercised directly
  // against the real executeMediaTool in integration/tool-execution.test.ts;
  // this test covers the orchestration-level state turn.ts itself owns:
  // independent ToolInvocation rows and independent credit capture.)
  it("generate_image then crop_image in the same turn — independent ToolInvocation rows, no credit-hold cross-contamination", async () => {
    const userId = "user_tool_orch_9";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
    await registerOwnedAsset(dbUser.id, chat.id, CROP_CALL.args.image_url as string);

    const GENERATE_CALL: ResolvedToolCall = {
      id: "call_generate",
      name: "generate_image",
      args: { prompt: "a cat" },
    };

    triggerAndWait
      .mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
        await testDb.toolInvocation.update({
          where: { id: toolInvocationId },
          data: { status: "COMPLETED", resultUrls: ["https://out.example.com/generated.png"], creditUsed: 0.1, finishedAt: new Date() },
        });
        return {
          ok: true,
          output: { status: "COMPLETED", resultUrls: ["https://out.example.com/generated.png"], creditUsedApp: 0.1, durationMs: 200 },
        };
      })
      .mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
        await testDb.toolInvocation.update({
          where: { id: toolInvocationId },
          data: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsed: 0.05, finishedAt: new Date() },
        });
        return {
          ok: true,
          output: { status: "COMPLETED", resultUrls: ["https://out.example.com/cropped.png"], creditUsedApp: 0.05, durationMs: 50 },
        };
      });

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.([GENERATE_CALL, CROP_CALL], 0)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_tool_9"));

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { callIndex: "asc" } });
    expect(invocations).toHaveLength(2);
    expect(invocations.map((i) => i.name)).toEqual(["generate_image", "crop_image"]);
    expect(invocations.map((i) => i.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(Number(invocations[0].creditUsed)).toBeCloseTo(0.1, 6);
    expect(Number(invocations[1].creditUsed)).toBeCloseTo(0.05, 6);
    expect(invocations[0].resultUrls).toEqual(["https://out.example.com/generated.png"]);
    expect(invocations[1].resultUrls).toEqual(["https://out.example.com/cropped.png"]);

    // Each tool's own capture is independently ledgered — no shared/merged
    // credit-hold state between the two engines.
    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" }, orderBy: { createdAt: "asc" } });
    expect(captureRows).toHaveLength(2);
    expect(captureRows[0].toolInvocationId).toBe(invocations[0].id);
    expect(captureRows[1].toolInvocationId).toBe(invocations[1].id);
    expect(Number(captureRows[0].amount)).toBeCloseTo(0.1, 6);
    expect(Number(captureRows[1].amount)).toBeCloseTo(0.05, 6);

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("CAPTURED");
    expect(Number(hold.capturedAmount)).toBeCloseTo(0.15, 6);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("completed");
  });

  // testing-policy.md's lifecycle-transition requirement: merge_videos run
  // twice on two SUCCESSIVE AgentRuns of the same chat must not leak any
  // state across runs — each run gets its own hold/ToolInvocation/stream
  // writes, and the second run's success must not be contaminated by
  // anything left over from the first (mirrors credit-invariants.test.ts's
  // own per-run assertCreditInvariants-style isolation checks).
  it("merge_videos on two successive AgentRuns of the same chat — no stale hold/stream state carries across runs", async () => {
    const userId = "user_tool_orch_10";
    const chat = await createChatAs(userId);
    const dbUser0 = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const videoUrl = "https://example.com/clip.mp4";
    await registerOwnedAsset(dbUser0.id, chat.id, videoUrl);

    const MERGE_CALL: ResolvedToolCall = {
      id: "call_merge",
      name: "merge_videos",
      args: { video_urls: [videoUrl, videoUrl] },
    };

    function mockOneMergeRound(resultUrl: string) {
      runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
        const results = (await params.onToolCalls?.([MERGE_CALL], 0)) ?? [];
        await params.onDelta({ index: 0, delta: "merged." });
        return {
          outcome: "completed" as const,
          text: "merged.",
          chunkCount: 1,
          finishReason: "stop",
          resolvedModel: "upstage/solar-pro-3:free",
          usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
          toolResultsForAssertion: results,
        };
      });
      triggerAndWait.mockImplementationOnce(async ({ toolInvocationId }: { toolInvocationId: string }) => {
        await testDb.toolInvocation.update({
          where: { id: toolInvocationId },
          data: { status: "COMPLETED", resultUrls: [resultUrl], creditUsed: 0.05, finishedAt: new Date() },
        });
        return { ok: true, output: { status: "COMPLETED", resultUrls: [resultUrl], creditUsedApp: 0.05, durationMs: 60 } };
      });
    }

    // Run 1.
    const { run: run1, message: message1 } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload1 = { runId: run1.id, chatId: chat.id, userMessageId: message1.id, userId: dbUser.id, requestedModel: run1.requestedModel };
    mockOneMergeRound("https://out.example.com/merged1.mp4");
    await executeAgentTurn(payload1, fakeCtx("trigger_tool_10a"));

    const invocations1 = await testDb.toolInvocation.findMany({ where: { agentRunId: run1.id } });
    expect(invocations1).toHaveLength(1);
    expect(invocations1[0].status).toBe("COMPLETED");
    const hold1 = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run1.id } });
    expect(hold1.status).toBe("CAPTURED");
    const streamWritesRun1 = streamWrite.mock.calls.length;

    // Run 2 — a fresh AgentRun on the SAME chat.
    resetTriggerMocks();
    streamWrite.mockClear();
    await registerOwnedAsset(dbUser.id, chat.id, videoUrl); // fresh attachment row; run1's own doesn't carry forward as "owned" for a new message
    const { run: run2, message: message2 } = await sendAs(userId, chat.id);
    expect(run2.id).not.toBe(run1.id);
    const payload2 = { runId: run2.id, chatId: chat.id, userMessageId: message2.id, userId: dbUser.id, requestedModel: run2.requestedModel };
    mockOneMergeRound("https://out.example.com/merged2.mp4");
    await executeAgentTurn(payload2, fakeCtx("trigger_tool_10b"));

    // Run 2 gets its own ToolInvocation, independent of run 1's — no
    // leaked/reused row, no inherited status.
    const invocations2 = await testDb.toolInvocation.findMany({ where: { agentRunId: run2.id } });
    expect(invocations2).toHaveLength(1);
    expect(invocations2[0].id).not.toBe(invocations1[0].id);
    expect(invocations2[0].status).toBe("COMPLETED");
    expect(invocations2[0].resultUrls).toEqual(["https://out.example.com/merged2.mp4"]);

    // Run 2's own hold is independently CAPTURED — run 1's hold is untouched
    // and not re-used or re-released by run 2's finalize.
    const hold2 = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run2.id } });
    expect(hold2.status).toBe("CAPTURED");
    expect(hold2.id).not.toBe(hold1.id);
    const hold1Recheck = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run1.id } });
    expect(hold1Recheck.status).toBe("CAPTURED");
    expect(Number(hold1Recheck.capturedAmount)).toBeCloseTo(Number(hold1.capturedAmount), 6);

    // Stream writes for run 2 start from a clean slate — the mock was
    // cleared, so any count > 0 here is entirely run 2's own writes, not a
    // leftover backlog from run 1.
    expect(streamWrite.mock.calls.length).toBeGreaterThan(0);
    expect(streamWritesRun1).toBeGreaterThan(0);

    const finalRun2 = await testDb.agentRun.findUniqueOrThrow({ where: { id: run2.id } });
    expect(finalRun2.status).toBe("completed");
  });
});
