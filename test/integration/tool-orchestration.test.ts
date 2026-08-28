import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// This suite doesn't care about skill content — avoid the cwd/chdir dance the skills-orchestration
// suite needs, since executeAgentTurn now always composes the skill roster into the system prompt.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite, triggerAndWait, batchTriggerAndWait } = vi.hoisted(() => {
  const triggerAndWaitFn = vi.fn();
  return {
    runAgentLoop: vi.fn(),
    streamWrite: vi.fn(),
    triggerAndWait: triggerAndWaitFn,
    // turn.ts dispatches a round's reserved calls via `mediaTool.batchTriggerAndWait`
    // (2026-08-29 — batchTriggerAndWait is the Trigger.dev-documented mechanism for
    // concurrent triggerAndWait-equivalent dispatch; parallel triggerAndWait calls
    // are themselves unsupported). This default implementation delegates each batch
    // item to the existing `triggerAndWait` mock and wraps the results as
    // `{ runs: [...] }`, so every existing `triggerAndWait.mockImplementationOnce(...)`
    // setup below keeps working unchanged for a round with one call — `items.map`
    // invokes the callback synchronously in array order, so queued
    // `mockImplementationOnce` results are still consumed in call order even though
    // the underlying promises resolve concurrently. Tests asserting genuine
    // parallelism (not the old bug's silent re-serialization) assert directly on
    // `batchTriggerAndWait.mock.calls` — one call with N items proves a real batch,
    // vs. N separate one-item calls proving the batching regressed.
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
  // `mockClear`, not `mockReset` — this must keep its default
  // triggerAndWait-delegating implementation (set once in `vi.hoisted`
  // above); a full reset would wipe that implementation and every test
  // relying on it (i.e. every test that doesn't itself assert on
  // batchTriggerAndWait) would start returning `undefined`.
  batchTriggerAndWait.mockClear();
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
    // credit-hold state between the two engines. Keyed by toolInvocationId,
    // not array position: both calls are now genuinely dispatched
    // concurrently in one batch (2026-08-29 fix), so which capture's
    // transaction commits — and is thus inserted — first is not guaranteed
    // to match model-emitted call order; only the settled tool_use/
    // tool_result block order above is guaranteed to be deterministic.
    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(2);
    const captureByInvocation = new Map(captureRows.map((row) => [row.toolInvocationId, row]));
    expect(Number(captureByInvocation.get(invocations[0].id)?.amount)).toBeCloseTo(0.1, 6);
    expect(Number(captureByInvocation.get(invocations[1].id)?.amount)).toBeCloseTo(0.05, 6);

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

// 2026-08-29 fix — production incident: three independent generate_image
// calls in one round ran strictly sequentially (a Trigger.dev trace showed
// waitpoint -> media-tool -> waitpoint -> media-tool -> waitpoint ->
// media-tool with zero overlap), because the per-call CREDIT_APPROVAL
// waitpoint's flushPending() drained the batch on every over-threshold
// call before the next could be queued. These tests are the regression
// guard: they fail against the old per-call-waitpoint code (batchTriggerAndWait
// would be called N times with 1 item each, never once with N items; wall
// time would be ~N*DELAY_MS, not ~DELAY_MS) and pass against the current
// round-level-waitpoint + batchTriggerAndWait implementation.
describe("executeAgentTurn — genuine parallel tool dispatch (2026-08-29 fix)", () => {
  const PARALLEL_CALLS: ResolvedToolCall[] = [
    { id: "call_a", name: "generate_image", args: { prompt: "a cat in a bathtub" } },
    { id: "call_b", name: "generate_image", args: { prompt: "a lion on a tree" } },
    { id: "call_c", name: "generate_image", args: { prompt: "an elephant riding a wave" } },
  ];

  function mockOneParallelRound(calls: ResolvedToolCall[]) {
    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const results = (await params.onToolCalls?.(calls, 0)) ?? [];
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
  }

  it("three above-threshold calls in one round: exactly one waitpoint, one batched dispatch, genuinely overlapping intervals", async () => {
    const userId = "user_tool_parallel_1";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    const DELAY_MS = 60;
    const intervals: { start: number; end: number }[] = [];
    triggerAndWait.mockImplementation(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      intervals.push({ start, end: Date.now() });
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsed: 0.1, finishedAt: new Date() },
      });
      return { ok: true, output: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsedApp: 0.1, durationMs: DELAY_MS } };
    });

    mockOneParallelRound(PARALLEL_CALLS);

    const wallStart = Date.now();
    await executeAgentTurn(payload, fakeCtx("trigger_parallel_1"));
    const wallElapsed = Date.now() - wallStart;

    // ONE round-level waitpoint listing all three calls — not three.
    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);
    expect((waitpoints[0].requestPayload as { calls: unknown[] }).calls).toHaveLength(3);

    // Genuine batching: one batchTriggerAndWait call carrying all three
    // items — not three separate one-item calls (the old bug's signature).
    expect(batchTriggerAndWait).toHaveBeenCalledTimes(1);
    expect(batchTriggerAndWait.mock.calls[0][0]).toHaveLength(3);

    // Real-time proof, not just a call-shape assertion: three genuinely
    // sequential DELAY_MS dispatches would take >= 3*DELAY_MS wall time.
    // Generous bound to absorb CI/scheduler jitter without being able to
    // pass under the old serialized behavior.
    expect(wallElapsed).toBeLessThan(DELAY_MS * 2.5);
    const overlaps = intervals.some((a, i) => intervals.some((b, j) => i !== j && a.start < b.end && b.start < a.end));
    expect(overlaps).toBe(true);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(3);
    expect(invocations.every((inv) => inv.status === "COMPLETED")).toBe(true);
  });

  it("a declined round fails every over-threshold call with zero reservations and zero dispatches", async () => {
    const userId = "user_tool_parallel_2";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    wait.forToken = vi.fn(async (id: string) => {
      await testDb.waitpoint.updateMany({
        where: { triggerTokenId: id, status: "PENDING" },
        data: { status: "COMPLETED", resolvedPayload: { approved: false, respondedAt: new Date().toISOString() }, resolvedAt: new Date() },
      });
      return { ok: true, output: {} };
    });

    mockOneParallelRound(PARALLEL_CALLS);
    await executeAgentTurn(payload, fakeCtx("trigger_parallel_2"));

    // Declined before ToolInvocation row creation — nothing was ever
    // created or dispatched for any of the three calls.
    expect(await testDb.toolInvocation.count({ where: { agentRunId: run.id } })).toBe(0);
    expect(triggerAndWait).not.toHaveBeenCalled();
    expect(batchTriggerAndWait).not.toHaveBeenCalled();
    const additionalReserves = await testDb.creditLedger.findMany({
      where: { runId: run.id, kind: "RESERVE", toolInvocationId: { not: null } },
    });
    expect(additionalReserves).toHaveLength(0);

    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; status?: string; errorMessage?: string }>;
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    expect(toolResults).toHaveLength(3);
    expect(toolResults.every((b) => b.status === "FAILED" && b.errorMessage === "The user did not approve this action.")).toBe(true);
  });

  it("a mixed round only gates the over-threshold call — the below-threshold call dispatches in the same batch without approval", async () => {
    const userId = "user_tool_parallel_3";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const videoUrl = "https://example.com/clip.mp4";
    await registerOwnedAsset(dbUser.id, chat.id, videoUrl);
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    // generate_image (0.1) is over APPROVAL_CREDIT_THRESHOLD (0.08);
    // merge_videos (0.05) is under it.
    const GEN_CALL: ResolvedToolCall = { id: "call_gen", name: "generate_image", args: { prompt: "a cat" } };
    const MERGE_CALL: ResolvedToolCall = { id: "call_merge", name: "merge_videos", args: { video_urls: [videoUrl, videoUrl] } };

    triggerAndWait.mockImplementation(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/x"], finishedAt: new Date() },
      });
      return { ok: true, output: { status: "COMPLETED", resultUrls: ["https://out.example.com/x"], creditUsedApp: 0.05, durationMs: 10 } };
    });

    mockOneParallelRound([GEN_CALL, MERGE_CALL]);
    await executeAgentTurn(payload, fakeCtx("trigger_parallel_3"));

    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);
    const calls = (waitpoints[0].requestPayload as { calls: { toolName: string }[] }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("generate_image");

    // Both calls still land in the SAME batchTriggerAndWait dispatch — the
    // below-threshold call was never gated, but it's still reserved/queued
    // in the same round-admission pass as the (now-approved) over-threshold
    // one, so both flush together.
    expect(batchTriggerAndWait).toHaveBeenCalledTimes(1);
    expect(batchTriggerAndWait.mock.calls[0][0]).toHaveLength(2);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(2);
    expect(invocations.every((inv) => inv.status === "COMPLETED")).toBe(true);
  });

  it("persists tool_use/tool_result blocks in model-emitted order even when the LAST call finishes FIRST (completion-race order must never leak into persisted content)", async () => {
    const userId = "user_tool_parallel_4";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    // Inverse delay order: call index 2 (last, callIndex 2) resolves
    // fastest; call index 0 (first) resolves slowest.
    const delaysByCallOrder = [90, 45, 5];
    let seen = 0;
    triggerAndWait.mockImplementation(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      const delay = delaysByCallOrder[seen++];
      await new Promise((resolve) => setTimeout(resolve, delay));
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: [`https://out.example.com/${toolInvocationId}.png`], creditUsed: 0.1, finishedAt: new Date() },
      });
      return {
        ok: true,
        output: { status: "COMPLETED", resultUrls: [`https://out.example.com/${toolInvocationId}.png`], creditUsedApp: 0.1, durationMs: delay },
      };
    });

    mockOneParallelRound(PARALLEL_CALLS);
    await executeAgentTurn(payload, fakeCtx("trigger_parallel_4"));

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: { callIndex: "asc" } });
    expect(invocations.map((i) => i.callIndex)).toEqual([0, 1, 2]);

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    const assistantMessage = await testDb.message.findUniqueOrThrow({ where: { id: finalRun.assistantMessageId! } });
    const blocks = assistantMessage.content as Array<{ type: string; toolUseId?: string; toolInvocationId?: string; id?: string }>;
    const toolUseIds = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    const toolResultInvocationIds = blocks.filter((b) => b.type === "tool_result").map((b) => b.toolInvocationId);
    // tool_use blocks are written serially during admission (unaffected by
    // dispatch concurrency) — always in call order.
    expect(toolUseIds).toEqual(["call_a", "call_b", "call_c"]);
    // tool_result blocks are the ones at risk of completion-race reordering
    // — must still land in original call order despite call_c finishing
    // its dispatch first.
    expect(toolResultInvocationIds).toEqual(invocations.map((i) => i.id));
  });

  it("repeated transition: two rounds of parallel tools in the same turn — no leaked pending/hold state between rounds, monotonic stream indices", async () => {
    const userId = "user_tool_parallel_5";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    const ROUND_1: ResolvedToolCall[] = [
      { id: "r1_a", name: "generate_image", args: { prompt: "round 1 a" } },
      { id: "r1_b", name: "generate_image", args: { prompt: "round 1 b" } },
    ];
    const ROUND_2: ResolvedToolCall[] = [
      { id: "r2_a", name: "generate_image", args: { prompt: "round 2 a" } },
      { id: "r2_b", name: "generate_image", args: { prompt: "round 2 b" } },
    ];

    triggerAndWait.mockImplementation(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsed: 0.1, finishedAt: new Date() },
      });
      return { ok: true, output: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsedApp: 0.1, durationMs: 5 } };
    });

    runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
      const round1 = (await params.onToolCalls?.(ROUND_1, 0)) ?? [];
      const round2 = (await params.onToolCalls?.(ROUND_2, 1)) ?? [];
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

    await executeAgentTurn(payload, fakeCtx("trigger_parallel_5"));

    // generate_image was already decided (approved) in round 1's waitpoint
    // — round 2 never re-asks (the consent memo — see
    // integration/waitpoints.test.ts for the dedicated consent-memo
    // coverage), so only ONE waitpoint exists for the whole run.
    const waitpoints = await testDb.waitpoint.findMany({ where: { agentRunId: run.id } });
    expect(waitpoints).toHaveLength(1);

    // Each round flushed its own batch independently — two
    // batchTriggerAndWait calls of two items each, never merged into one
    // call of four (proving `pending` was empty at the start of round 2,
    // not carrying round 1's items forward) and never split unexpectedly.
    expect(batchTriggerAndWait).toHaveBeenCalledTimes(2);
    expect(batchTriggerAndWait.mock.calls[0][0]).toHaveLength(2);
    expect(batchTriggerAndWait.mock.calls[1][0]).toHaveLength(2);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id }, orderBy: [{ turnIndex: "asc" }, { callIndex: "asc" }] });
    expect(invocations).toHaveLength(4);
    expect(invocations.map((i) => i.turnIndex)).toEqual([0, 0, 1, 1]);
    expect(invocations.every((inv) => inv.status === "COMPLETED")).toBe(true);

    // No leaked/duplicated CreditHold — one hold for the whole run,
    // capturing all four dispatches' worth of credit.
    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("CAPTURED");
    expect(Number(hold.capturedAmount)).toBeCloseTo(0.4, 6);

    // Stream indices are strictly increasing across both rounds — no
    // duplicate or reused index, and round 2 continues where round 1 left
    // off rather than restarting.
    const writtenIndices = streamWrite.mock.calls.map(([part]) => (part as { index: number }).index);
    for (let i = 1; i < writtenIndices.length; i++) {
      expect(writtenIndices[i]).toBeGreaterThan(writtenIndices[i - 1]);
    }
  });

  it("caps concurrent dispatch at MAX_PARALLEL_TOOL_DISPATCH — a 12-call round chunks into batches of at most 5", async () => {
    const userId = "user_tool_parallel_6";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };

    const TWELVE_CALLS: ResolvedToolCall[] = Array.from({ length: 12 }, (_, i) => ({
      id: `call_${i}`,
      name: "generate_image",
      args: { prompt: `prompt ${i}` },
    }));

    let concurrent = 0;
    let maxConcurrent = 0;
    triggerAndWait.mockImplementation(async ({ toolInvocationId }: { toolInvocationId: string }) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent--;
      await testDb.toolInvocation.update({
        where: { id: toolInvocationId },
        data: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsed: 0.1, finishedAt: new Date() },
      });
      return { ok: true, output: { status: "COMPLETED", resultUrls: ["https://out.example.com/x.png"], creditUsedApp: 0.1, durationMs: 20 } };
    });

    mockOneParallelRound(TWELVE_CALLS);
    await executeAgentTurn(payload, fakeCtx("trigger_parallel_6"));

    // MAX_PARALLEL_TOOL_DISPATCH is 5 — 12 calls chunk into 5 + 5 + 2,
    // three separate batchTriggerAndWait calls, never all 12 in one call
    // and never more than 5 truly concurrent at any instant.
    expect(batchTriggerAndWait).toHaveBeenCalledTimes(3);
    expect(batchTriggerAndWait.mock.calls.map((call) => (call[0] as unknown[]).length)).toEqual([5, 5, 2]);
    expect(maxConcurrent).toBeLessThanOrEqual(5);

    const invocations = await testDb.toolInvocation.findMany({ where: { agentRunId: run.id } });
    expect(invocations).toHaveLength(12);
    expect(invocations.every((inv) => inv.status === "COMPLETED")).toBe(true);
  });
});
