/**
 * The `kind: "local"` branch of `buildToolExecutor` end to end: a
 * mocked-LLM turn whose model calls `load_skill`. The load-bearing
 * assertion is the negative one — a skill step must never create a
 * ToolInvocation row, reserve credit, or dispatch a child media task, i.e.
 * skills must not silently become billable async work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

const { runAgentLoop, streamWrite, triggerAndWait, batchTriggerAndWait } = vi.hoisted(() => {
  const triggerAndWaitFn = vi.fn();
  return {
    runAgentLoop: vi.fn(),
    streamWrite: vi.fn(),
    triggerAndWait: triggerAndWaitFn,
    // Same triggerAndWait-delegating shim as tool-orchestration.test.ts —
    // this suite never actually dispatches to media-tool (it only exercises
    // local/skill tools), but turn.ts now calls `mediaTool.batchTriggerAndWait`
    // rather than `triggerAndWait`, so the mock must expose it regardless.
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
import { __resetSkillRegistryCacheForTests } from "@/server/skills/registry";
import { __resetApprovedSkillsRootCacheForTests } from "@/server/skills/fs-boundary";
import type { ResolvedToolCall, RunAgentLoopParams } from "@/server/agent/loop";

const BASE = "http://localhost/api/v1/chats";
// The registry resolves `agent-skills/` from process.cwd() — same chdir
// approach as integration/skills-load.test.ts.
const REAL_BACKEND_DIR = path.resolve(__dirname, "../../backend");
const REAL_SKILL_NAME = "crop-image-guidance";

function fakeCtx(triggerRunId: string) {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

async function startTurn(userId: string) {
  const chatRes = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  const chat = await chatRes.json();
  const sendRes = await sendMessage(
    authedRequest(`${BASE}/${chat.id}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "how do I crop?" }] }),
    }),
    { params: Promise.resolve({ chatId: chat.id }) },
  );
  const { run, message } = await sendRes.json();
  const dbUser = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
  return { runId: run.id, chatId: chat.id, userMessageId: message.id, userId: dbUser.id, requestedModel: run.requestedModel };
}

function mockOneToolRound(call: ResolvedToolCall) {
  runAgentLoop.mockImplementationOnce(async (params: RunAgentLoopParams) => {
    const results = (await params.onToolCalls?.([call], 0)) ?? [];
    await params.onDelta({ index: 0, delta: "ok." });
    return {
      outcome: "completed" as const,
      text: "ok.",
      chunkCount: 1,
      finishReason: "stop",
      resolvedModel: "upstage/solar-pro-3:free",
      usage: { promptTokens: 10, completionTokens: 2, costCredits: 0 },
      toolResultsForAssertion: results,
    };
  });
}

async function assistantBlocks(runId: string) {
  const run = await testDb.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const message = await testDb.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
  return message.content as { type: string; [k: string]: unknown }[];
}

let originalCwd: string;

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
  triggerAndWait.mockReset();
  originalCwd = process.cwd();
  process.chdir(REAL_BACKEND_DIR);
  __resetApprovedSkillsRootCacheForTests();
  __resetSkillRegistryCacheForTests();
});

afterEach(() => {
  process.chdir(originalCwd);
  __resetSkillRegistryCacheForTests();
  __resetApprovedSkillsRootCacheForTests();
});

describe("executeAgentTurn — local (skill) tool orchestration", () => {
  it("runs load_skill in-process: completed blocks, a RunSkill row, and NO ToolInvocation/credit/child-task work", async () => {
    const payload = await startTurn("user_skill_orch_1");
    mockOneToolRound({ id: "call_skill_1", name: "load_skill", args: { skillName: REAL_SKILL_NAME } });

    await executeAgentTurn(payload, fakeCtx("trigger_skill_1"));

    const blocks = await assistantBlocks(payload.runId);
    const toolUse = blocks.find((b) => b.type === "tool_use");
    expect(toolUse).toMatchObject({ name: "load_skill", id: "call_skill_1", input: { skillName: REAL_SKILL_NAME } });
    const toolResult = blocks.find((b) => b.type === "tool_result") as Record<string, unknown>;
    expect(toolResult).toMatchObject({ toolUseId: "call_skill_1", name: "load_skill", status: "COMPLETED", isError: false });
    expect(toolResult.toolInvocationId).toBeUndefined();
    expect((toolResult.output as { content: string }).content.length).toBeGreaterThan(0);

    // Regression coverage: a skill step must stream live (DISPATCHING then
    // COMPLETED "tool" parts), not only appear once the run settles and the
    // UI re-renders from the persisted blocks above.
    const toolStreamParts = streamWrite.mock.calls
      .map(([part]) => part as Record<string, unknown>)
      .filter((p) => p.type === "tool" && p.toolInvocationId === "call_skill_1");
    expect(toolStreamParts.map((p) => p.status)).toEqual(["DISPATCHING", "COMPLETED"]);

    // The whole point of the local branch: free, synchronous, no child task.
    expect(await testDb.toolInvocation.count()).toBe(0);
    // The run's own baseline HOLD/RELEASE rows still exist; what must not
    // exist is any tool-attributed reservation or capture.
    expect(await testDb.creditLedger.count({ where: { runId: payload.runId, toolInvocationId: { not: null } } })).toBe(0);
    expect(await testDb.creditLedger.count({ where: { runId: payload.runId, kind: "CAPTURE" } })).toBe(0);
    expect(triggerAndWait).not.toHaveBeenCalled();

    const skillRows = await testDb.runSkill.findMany({ where: { agentRunId: payload.runId } });
    expect(skillRows.map((r) => r.skillName)).toEqual([REAL_SKILL_NAME]);
    expect(await testDb.agentRun.findUniqueOrThrow({ where: { id: payload.runId } })).toMatchObject({ status: "completed" });
  });

  it("surfaces an unknown skill as a failed tool step without creating a ToolInvocation or RunSkill row", async () => {
    const payload = await startTurn("user_skill_orch_2");
    mockOneToolRound({ id: "call_skill_2", name: "load_skill", args: { skillName: "does-not-exist" } });

    await executeAgentTurn(payload, fakeCtx("trigger_skill_2"));

    const toolResult = (await assistantBlocks(payload.runId)).find((b) => b.type === "tool_result") as Record<string, unknown>;
    expect(toolResult).toMatchObject({ toolUseId: "call_skill_2", name: "load_skill", status: "FAILED", isError: true });
    expect(await testDb.toolInvocation.count()).toBe(0);
    expect(await testDb.runSkill.count()).toBe(0);

    const toolStreamParts = streamWrite.mock.calls
      .map(([part]) => part as Record<string, unknown>)
      .filter((p) => p.type === "tool" && p.toolInvocationId === "call_skill_2");
    expect(toolStreamParts.map((p) => p.status)).toEqual(["DISPATCHING", "FAILED"]);
  });
});
