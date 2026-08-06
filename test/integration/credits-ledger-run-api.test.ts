import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getLedgerByRun } from "@/app/api/v1/me/credits/ledger/run/[runId]/route";
import { reserveHold, reserveAdditional, captureForTool, releaseHold } from "@/services/credits";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/me/credits/ledger/run";

async function makeUser(clerkUserId: string, creditBalance = 100) {
  return testDb.user.create({ data: { clerkUserId, creditBalance } });
}

async function makeChatAndRun(ownerId: string, seq: number) {
  const chat = await testDb.chat.create({ data: { ownerId, title: "t" } });
  const userMessage = await testDb.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  const run = await testDb.agentRun.create({
    data: {
      chatId: chat.id,
      idempotencyKey: `send:${chat.id}:${userMessage.id}:${seq}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
    },
  });
  return { chat, run };
}

function call(runId: string, userId: string) {
  return getLedgerByRun(authedRequest(`${BASE}/${runId}`, userId), { params: Promise.resolve({ runId }) });
}

describe("GET /api/v1/me/credits/ledger/run/[runId]", () => {
  it("returns the full RESERVE/CAPTURE/RELEASE lifecycle for a run, oldest first, with chatId", async () => {
    const user = await makeUser("user_run_steps_1", 100);
    const { chat, run } = await makeChatAndRun(user.id, 1);
    const cropTool = await testDb.toolInvocation.create({
      data: { agentRunId: run.id, turnIndex: 0, callIndex: 0, toolCallId: "call_crop", name: "crop_image", nodeType: "crop_image", input: {} },
    });

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 1 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) => reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: cropTool.id, amount: 4 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: cropTool.id, amount: 4 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const res = await call(run.id, "user_run_steps_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chatId).toBe(chat.id);
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(["RESERVE", "RESERVE", "CAPTURE", "RELEASE"]);
    const capture = body.items.find((i: { kind: string }) => i.kind === "CAPTURE");
    expect(capture.toolName).toBe("crop_image");
    expect(capture.toolInvocationId).toBe(cropTool.id);
    const firstReserve = body.items[0];
    expect(firstReserve.toolName).toBeNull();
  });

  it("per-caller isolation: another user's runId returns an empty, non-leaking result", async () => {
    const userA = await makeUser("user_run_steps_a", 100);
    const userB = await makeUser("user_run_steps_b", 100);
    const { run: runA } = await makeChatAndRun(userA.id, 1);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: runA.id, userId: userA.id, amount: 2 }));

    const res = await call(runA.id, "user_run_steps_b");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.chatId).toBeNull();
  });

  it("an unknown runId returns an honest empty result, not an error", async () => {
    const user = await makeUser("user_run_steps_unknown", 100);
    const res = await call("run_does_not_exist", "user_run_steps_unknown");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.chatId).toBeNull();
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getLedgerByRun(anonymousRequest(`${BASE}/whatever`), { params: Promise.resolve({ runId: "whatever" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
