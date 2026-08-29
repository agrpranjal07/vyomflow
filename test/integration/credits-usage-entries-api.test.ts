import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getUsageEntries } from "@/app/api/v1/me/credits/usage-entries/route";
import { GET as getUsageEntriesByChat } from "@/app/api/v1/me/credits/usage-entries-by-chat/route";
import { GET as getLedgerByChat } from "@/app/api/v1/me/credits/ledger/chat/[chatId]/route";
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

  it("?period= filters by createdAt cutoff; omitted keeps the full unfiltered history", async () => {
    const user = await makeUser("user_entries_period", 100);

    const oldRun = await makeChatAndRun(user.id, 1);
    const cropOld = await makeToolInvocation(oldRun.id, "call_old", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: oldRun.id, userId: user.id, amount: 5 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: oldRun.id, userId: user.id, toolInvocationId: cropOld.id, amount: 5 }));
    // captureForTool stamps createdAt via the Prisma default ("now") — the
    // only way to place a row outside the 7d window is to backdate it.
    await testDb.creditLedger.updateMany({
      where: { runId: oldRun.id, kind: "CAPTURE" },
      data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const recentRun = await makeChatAndRun(user.id, 2);
    const cropRecent = await makeToolInvocation(recentRun.id, "call_recent", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: recentRun.id, userId: user.id, amount: 3 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: recentRun.id, userId: user.id, toolInvocationId: cropRecent.id, amount: 3 }));

    const filtered = await (await getUsageEntries(authedRequest(`${BASE}?tool=crop_image&period=7d`, "user_entries_period"))).json();
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0].runId).toBe(recentRun.id);

    // Omitted ?period= defaults to "all" — pre-filter behavior unchanged.
    const omitted = await (await getUsageEntries(authedRequest(`${BASE}?tool=crop_image`, "user_entries_period"))).json();
    expect(omitted.entries).toHaveLength(2);
    expect(omitted.entries.map((e: { runId: string }) => e.runId).sort()).toEqual([oldRun.id, recentRun.id].sort());
  });

  it("an unknown ?period= value is rejected as a bad request", async () => {
    await makeUser("user_entries_period_bad", 100);
    const res = await getUsageEntries(authedRequest(`${BASE}?tool=crop_image&period=nonsense`, "user_entries_period_bad"));
    expect(res.status).toBe(400);
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

const BY_CHAT_BASE = "http://localhost/api/v1/me/credits/usage-entries-by-chat";

describe("GET /api/v1/me/credits/usage-entries-by-chat", () => {
  it("nets tool + bare-LLM rows per chat, one entry per chat with the real chat title", async () => {
    const user = await makeUser("user_entries_chat_1", 100);

    const chatARun1 = await makeChatAndRun(user.id, 1);
    const cropTool = await makeToolInvocation(chatARun1.id, "call_crop", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: chatARun1.id, userId: user.id, amount: 5 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: chatARun1.id, userId: user.id, toolInvocationId: cropTool.id, amount: 5 }));
    const chatAMessage2 = await testDb.message.create({
      data: { chatId: chatARun1.chatId, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
    });
    // First run must be non-active (queued/running/waiting) before a second
    // run can be created on the same chat — agentrun_one_active_per_chat.
    await testDb.agentRun.update({ where: { id: chatARun1.id }, data: { status: "completed" } });
    const chatARun2 = await testDb.agentRun.create({
      data: {
        chatId: chatARun1.chatId,
        idempotencyKey: `send:${chatARun1.chatId}:extra:1`,
        userMessageId: chatAMessage2.id,
        requestedModel: "openrouter/free",
        status: "completed",
      },
    });
    await prisma.$transaction((tx) => recordUsage(tx, { runId: chatARun2.id, userId: user.id, turnIndex: 0, metadata: {} }));

    const chatBRun = await makeChatAndRun(user.id, 2);
    const generateTool = await makeToolInvocation(chatBRun.id, "call_generate", "generate_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: chatBRun.id, userId: user.id, amount: 7 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: chatBRun.id, userId: user.id, toolInvocationId: generateTool.id, amount: 7 }));

    const res = await getUsageEntriesByChat(authedRequest(BY_CHAT_BASE, "user_entries_chat_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);

    const chatA = await testDb.chat.findUniqueOrThrow({ where: { id: chatARun1.chatId } });
    const chatB = await testDb.chat.findUniqueOrThrow({ where: { id: chatBRun.chatId } });

    const entryA = body.entries.find((e: { chatId: string }) => e.chatId === chatARun1.chatId);
    expect(entryA.chatTitle).toBe(chatA.title);
    expect(Number(entryA.amount)).toBeCloseTo(5, 6);

    const entryB = body.entries.find((e: { chatId: string }) => e.chatId === chatBRun.chatId);
    expect(entryB.chatTitle).toBe(chatB.title);
    expect(Number(entryB.amount)).toBeCloseTo(7, 6);
  });

  it("per-caller isolation: never returns another user's chat entries", async () => {
    const userA = await makeUser("user_entries_chat_a", 100);
    const userB = await makeUser("user_entries_chat_b", 100);
    const runA = await makeChatAndRun(userA.id, 1);
    const runB = await makeChatAndRun(userB.id, 1);
    await prisma.$transaction((tx) => recordUsage(tx, { runId: runA.id, userId: userA.id, turnIndex: 0, metadata: {} }));
    await prisma.$transaction((tx) => recordUsage(tx, { runId: runB.id, userId: userB.id, turnIndex: 0, metadata: {} }));

    const res = await getUsageEntriesByChat(authedRequest(BY_CHAT_BASE, "user_entries_chat_a"));
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].chatId).toBe(runA.chatId);
  });

  it("?period= filters by createdAt cutoff; omitted keeps the full unfiltered history", async () => {
    const user = await makeUser("user_entries_chat_period", 100);

    const oldRun = await makeChatAndRun(user.id, 1);
    const cropOld = await makeToolInvocation(oldRun.id, "call_old", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: oldRun.id, userId: user.id, amount: 5 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: oldRun.id, userId: user.id, toolInvocationId: cropOld.id, amount: 5 }));
    await testDb.creditLedger.updateMany({
      where: { runId: oldRun.id, kind: "CAPTURE" },
      data: { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const recentRun = await makeChatAndRun(user.id, 2);
    const cropRecent = await makeToolInvocation(recentRun.id, "call_recent", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: recentRun.id, userId: user.id, amount: 3 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: recentRun.id, userId: user.id, toolInvocationId: cropRecent.id, amount: 3 }));

    const filtered = await (await getUsageEntriesByChat(authedRequest(`${BY_CHAT_BASE}?period=7d`, "user_entries_chat_period"))).json();
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0].chatId).toBe(recentRun.chatId);
    expect(Number(filtered.entries[0].amount)).toBeCloseTo(3, 6);

    // Omitted ?period= defaults to "all" — pre-filter behavior unchanged.
    const omitted = await (await getUsageEntriesByChat(authedRequest(BY_CHAT_BASE, "user_entries_chat_period"))).json();
    expect(omitted.entries).toHaveLength(2);
    expect(omitted.entries.map((e: { chatId: string }) => e.chatId).sort()).toEqual([oldRun.chatId, recentRun.chatId].sort());
  });

  it("an unknown ?period= value is rejected as a bad request", async () => {
    await makeUser("user_entries_chat_period_bad", 100);
    const res = await getUsageEntriesByChat(authedRequest(`${BY_CHAT_BASE}?period=nonsense`, "user_entries_chat_period_bad"));
    expect(res.status).toBe(400);
  });

  it("returns an honest empty list, not an error, when there is no activity", async () => {
    await makeUser("user_entries_chat_empty", 100);
    const res = await getUsageEntriesByChat(authedRequest(BY_CHAT_BASE, "user_entries_chat_empty"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getUsageEntriesByChat(anonymousRequest(BY_CHAT_BASE));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

const LEDGER_BY_CHAT_BASE = "http://localhost/api/v1/me/credits/ledger/chat";

function callLedgerByChat(chatId: string, userId: string) {
  return getLedgerByChat(authedRequest(`${LEDGER_BY_CHAT_BASE}/${chatId}`, userId), { params: Promise.resolve({ chatId }) });
}

describe("GET /api/v1/me/credits/ledger/chat/[chatId]", () => {
  it("lists one row per (tool, run) within the chat, with the real chat title", async () => {
    const user = await makeUser("user_ledger_chat_1", 100);
    const run1 = await makeChatAndRun(user.id, 1);
    const cropTool = await makeToolInvocation(run1.id, "call_crop", "crop_image");
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run1.id, userId: user.id, amount: 5 }));
    await prisma.$transaction((tx) => captureForTool(tx, { runId: run1.id, userId: user.id, toolInvocationId: cropTool.id, amount: 5 }));

    const message2 = await testDb.message.create({
      data: { chatId: run1.chatId, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
    });
    await testDb.agentRun.update({ where: { id: run1.id }, data: { status: "completed" } });
    const run2 = await testDb.agentRun.create({
      data: {
        chatId: run1.chatId,
        idempotencyKey: `send:${run1.chatId}:extra:1`,
        userMessageId: message2.id,
        requestedModel: "openrouter/free",
        status: "completed",
      },
    });
    await prisma.$transaction((tx) => recordUsage(tx, { runId: run2.id, userId: user.id, turnIndex: 0, metadata: {} }));

    const chat = await testDb.chat.findUniqueOrThrow({ where: { id: run1.chatId } });
    const res = await callLedgerByChat(run1.chatId, "user_ledger_chat_1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chatTitle).toBe(chat.title);
    expect(body.items).toHaveLength(2);

    const cropItem = body.items.find((i: { runId: string }) => i.runId === run1.id);
    expect(cropItem.toolName).toBe("crop_image");
    expect(Number(cropItem.amount)).toBeCloseTo(5, 6);

    const bareLlmItem = body.items.find((i: { runId: string }) => i.runId === run2.id);
    expect(bareLlmItem.toolName).toBeNull();
  });

  it("per-caller isolation: another user's chatId returns an empty, non-leaking result", async () => {
    const userA = await makeUser("user_ledger_chat_a", 100);
    const userB = await makeUser("user_ledger_chat_b", 100);
    const runA = await makeChatAndRun(userA.id, 1);
    await prisma.$transaction((tx) => recordUsage(tx, { runId: runA.id, userId: userA.id, turnIndex: 0, metadata: {} }));

    const res = await callLedgerByChat(runA.chatId, "user_ledger_chat_b");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.chatTitle).toBeNull();
  });

  it("an unknown chatId returns an honest empty result, not an error", async () => {
    const user = await makeUser("user_ledger_chat_unknown", 100);
    const res = await callLedgerByChat("chat_does_not_exist", "user_ledger_chat_unknown");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.chatTitle).toBeNull();
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getLedgerByChat(anonymousRequest(`${LEDGER_BY_CHAT_BASE}/whatever`), { params: Promise.resolve({ chatId: "whatever" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
