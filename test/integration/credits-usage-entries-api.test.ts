import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getUsageEntries } from "@/app/api/v1/me/credits/usage-entries/route";
import { reserveHold, captureForTool, recordUsage } from "@/services/credits";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/me/credits/usage-entries";

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
  return run;
}

async function makeToolInvocation(agentRunId: string, toolCallId: string, name: string) {
  return testDb.toolInvocation.create({
    data: { agentRunId, turnIndex: 0, callIndex: 0, toolCallId, name, nodeType: name, input: {} },
  });
}

describe("GET /api/v1/me/credits/usage-entries", () => {
  it("nets a run's multiple CAPTURE rows for one tool into a single entry, newest first", async () => {
    const user = await makeUser("user_entries_1", 100);
    const runOld = await makeChatAndRun(user.id, 1);
    const cropOld = await makeToolInvocation(runOld.id, "call_old", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: runOld.id, userId: user.id, amount: 5 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: runOld.id, userId: user.id, toolInvocationId: cropOld.id, amount: 5 }));

    await new Promise((r) => setTimeout(r, 2));

    const runNew = await makeChatAndRun(user.id, 2);
    const cropNewA = await makeToolInvocation(runNew.id, "call_new_a", "crop_image");
    const cropNewB = await makeToolInvocation(runNew.id, "call_new_b", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: runNew.id, userId: user.id, amount: 10 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: runNew.id, userId: user.id, toolInvocationId: cropNewA.id, amount: 3 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: runNew.id, userId: user.id, toolInvocationId: cropNewB.id, amount: 2 }));

    const res = await getUsageEntries(authedRequest(`${BASE}?tool=crop_image`, "user_entries_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    // Newest run first.
    expect(body.entries[0].runId).toBe(runNew.id);
    expect(Number(body.entries[0].amount)).toBeCloseTo(5, 6);
    expect(body.entries[1].runId).toBe(runOld.id);
    expect(Number(body.entries[1].amount)).toBeCloseTo(5, 6);
  });

  it("scopes 'none' to bare LLM usage rows only", async () => {
    const user = await makeUser("user_entries_none", 100);
    const run = await makeChatAndRun(user.id, 1);
    await prisma.$transaction((tx) => recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: {} }));

    const res = await getUsageEntries(authedRequest(`${BASE}?tool=none`, "user_entries_none"));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].runId).toBe(run.id);
  });

  it("per-caller isolation: never returns another user's entries", async () => {
    const userA = await makeUser("user_entries_a", 100);
    const userB = await makeUser("user_entries_b", 100);
    const runA = await makeChatAndRun(userA.id, 1);
    const runB = await makeChatAndRun(userB.id, 1);
    await prisma.$transaction((tx) => recordUsage(tx, { runId: runA.id, userId: userA.id, turnIndex: 0, metadata: {} }));
    await prisma.$transaction((tx) => recordUsage(tx, { runId: runB.id, userId: userB.id, turnIndex: 0, metadata: {} }));

    const res = await getUsageEntries(authedRequest(`${BASE}?tool=none`, "user_entries_a"));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].runId).toBe(runA.id);
  });

  it("returns an honest empty list, not an error, when there is no history for that tool", async () => {
    const user = await makeUser("user_entries_empty", 100);
    const res = await getUsageEntries(authedRequest(`${BASE}?tool=crop_image`, "user_entries_empty"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });

  it("missing ?tool= is rejected as a bad request", async () => {
    const user = await makeUser("user_entries_bad", 100);
    const res = await getUsageEntries(authedRequest(BASE, "user_entries_bad"));
    expect(res.status).toBe(400);
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getUsageEntries(anonymousRequest(`${BASE}?tool=none`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
