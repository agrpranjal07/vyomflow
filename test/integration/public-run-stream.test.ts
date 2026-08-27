import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { GET as getStream } from "@/app/api/public/v1/runs/[runId]/stream/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";
import { __setScopedStreamParts, __setRunShapes, __resetTriggerSdkMock } from "../support/trigger-sdk-mock";

const RUNS_BASE = "http://localhost/api/public/v1/runs";

beforeEach(() => {
  resetTriggerMocks();
  __resetTriggerSdkMock();
});

async function makeUser(clerkUserId: string) {
  return testDb.user.create({ data: { clerkUserId, creditBalance: 100 } });
}

async function makeChat(ownerId: string) {
  return testDb.chat.create({ data: { ownerId, title: "t" } });
}

async function makeRun(chatId: string, triggerRunId: string, extra: Record<string, unknown> = {}) {
  const userMessage = await testDb.message.create({
    data: { chatId, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  return testDb.agentRun.create({
    data: {
      chatId,
      idempotencyKey: `send:${chatId}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
      status: "running",
      triggerRunId,
      ...extra,
    },
  });
}

async function makeToolInvocation(agentRunId: string, toolCallId: string) {
  return testDb.toolInvocation.create({
    data: { agentRunId, turnIndex: 0, callIndex: 0, toolCallId, name: "crop_image", nodeType: "crop_image", input: {} },
  });
}

type ParsedEvent = { id?: string; event?: string; data?: any };

async function readEvents(res: Response, count: number): Promise<{ events: ParsedEvent[]; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: ParsedEvent[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sepIndex;
    while ((sepIndex = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sepIndex);
      buf = buf.slice(sepIndex + 2);
      if (!frame || frame.startsWith(":")) continue;
      const parsed: ParsedEvent = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) parsed.id = line.slice(4);
        else if (line.startsWith("event: ")) parsed.event = line.slice(7);
        else if (line.startsWith("data: ")) parsed.data = JSON.parse(line.slice(6));
      }
      if (parsed.event) events.push(parsed);
      if (events.length >= count) break;
    }
  }
  return { events, reader };
}

describe("GET /api/public/v1/runs/:runId/stream", () => {
  it("connect, consume, disconnect, reconnect with Last-Event-ID — no duplicate, no gap; a second run on the same chat starts fresh with no leaked state", async () => {
    const user = await makeUser("user_stream_1");
    const chat = await makeChat(user.id);
    const run = await makeRun(chat.id, "trg_run_1");
    const tool = await makeToolInvocation(run.id, "call_1");

    __setScopedStreamParts("trg_run_1", "assistant", [
      { index: 0, type: "text", channel: "text", delta: "Hel" },
      { index: 1, type: "text", channel: "text", delta: "lo" },
      { index: 2, type: "tool", toolInvocationId: tool.id, name: "crop_image", status: "COMPLETED" },
    ]);
    __setRunShapes("trg_run_1", []);

    const firstRes = await getStream(authedRequest(`${RUNS_BASE}/${run.id}/stream`, "user_stream_1"), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(firstRes.status).toBe(200);

    const { events: firstEvents, reader: firstReader } = await readEvents(firstRes, 3);
    expect(firstEvents[0].event).toBe("run.status");
    expect(firstEvents[1]).toMatchObject({ event: "message.delta", id: "0" });
    expect(firstEvents[1].data).toMatchObject({ index: 0, delta: "Hel" });
    expect(firstEvents[2]).toMatchObject({ event: "message.delta", id: "1" });
    expect(firstEvents[2].data).toMatchObject({ index: 1, delta: "lo" });
    await firstReader.cancel();

    __setScopedStreamParts("trg_run_1", "assistant", [
      { index: 0, type: "text", channel: "text", delta: "Hel" },
      { index: 1, type: "text", channel: "text", delta: "lo" },
      { index: 2, type: "tool", toolInvocationId: tool.id, name: "crop_image", status: "COMPLETED" },
    ]);
    __setRunShapes("trg_run_1", []);

    const secondRes = await getStream(
      authedRequest(`${RUNS_BASE}/${run.id}/stream`, "user_stream_1", { headers: { "Last-Event-ID": "1" } }),
      { params: Promise.resolve({ runId: run.id }) },
    );
    expect(secondRes.status).toBe(200);
    const { events: secondEvents, reader: secondReader } = await readEvents(secondRes, 2);
    expect(secondEvents[0].event).toBe("run.status");
    expect(secondEvents[1]).toMatchObject({ event: "tool.status", id: "2" });
    expect(secondEvents[1].data).toMatchObject({
      index: 2,
      toolInvocationId: tool.id,
      toolCallId: "call_1",
      turnIndex: 0,
      callIndex: 0,
    });
    await secondReader.cancel();

    // Only one non-terminal run per chat is allowed (partial unique index on
    // agent_runs.chatId) — settle run 1 before starting run 2.
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "cancelled" } });

    // A second, independent run on the same chat must not see any state
    // leaked from the first run's connections (index space, tool cache, etc).
    const run2 = await makeRun(chat.id, "trg_run_2");
    __setScopedStreamParts("trg_run_2", "assistant", [{ index: 0, type: "text", channel: "text", delta: "fresh" }]);
    __setRunShapes("trg_run_2", []);

    const thirdRes = await getStream(authedRequest(`${RUNS_BASE}/${run2.id}/stream`, "user_stream_1"), {
      params: Promise.resolve({ runId: run2.id }),
    });
    expect(thirdRes.status).toBe(200);
    const { events: thirdEvents, reader: thirdReader } = await readEvents(thirdRes, 2);
    expect(thirdEvents[1]).toMatchObject({ event: "message.delta", id: "0" });
    expect(thirdEvents[1].data).toMatchObject({ index: 0, delta: "fresh" });
    await thirdReader.cancel();
  });

  it("a run already terminal when the connection is opened sends only the snapshot and terminal event, then closes", async () => {
    const user = await makeUser("user_stream_2");
    const chat = await makeChat(user.id);
    const run = await makeRun(chat.id, "trg_run_terminal");
    const assistantMessage = await testDb.message.create({
      data: { chatId: chat.id, role: "assistant", status: "complete", content: [{ type: "text", text: "done" }] },
    });
    await testDb.agentRun.update({
      where: { id: run.id },
      data: { status: "completed", assistantMessageId: assistantMessage.id, finishedAt: new Date() },
    });

    const res = await getStream(authedRequest(`${RUNS_BASE}/${run.id}/stream`, "user_stream_2"), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);

    const { events, reader } = await readEvents(res, 2);
    expect(events[0]).toMatchObject({ event: "run.status", data: { status: "completed" } });
    expect(events[1].event).toBe("run.completed");
    expect(events[1].data).toMatchObject({ runId: run.id, assistantMessageId: assistantMessage.id, totalCreditsUsed: 0 });

    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});
