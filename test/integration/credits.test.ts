import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { reserveHold, releaseHold, recordUsage, InsufficientCreditsError } from "@/services/credits";
import { testDb } from "../support/db";
import { assertCreditInvariants } from "../support/credit-invariants";

async function makeUser(clerkUserId: string, creditBalance = 100) {
  return testDb.user.create({ data: { clerkUserId, creditBalance } });
}

async function makeChatAndRun(ownerId: string, requestedModel = "openrouter/free") {
  const chat = await testDb.chat.create({ data: { ownerId, title: "t" } });
  const userMessage = await testDb.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  const run = await testDb.agentRun.create({
    data: {
      chatId: chat.id,
      idempotencyKey: `send:${chat.id}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel,
    },
  });
  return { chat, userMessage, run };
}

describe("credits — reserveHold / releaseHold / recordUsage", () => {
  it("reserve creates one OPEN hold and one RESERVE ledger row, and debits creditHeld", async () => {
    const user = await makeUser("user_credits_1", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));

    const hold = await testDb.creditHold.findUnique({ where: { runId: run.id } });
    expect(hold?.status).toBe("OPEN");
    expect(Number(hold?.amount)).toBe(0.01);

    const ledger = await testDb.creditLedger.findMany({ where: { runId: run.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].kind).toBe("RESERVE");
    expect(ledger[0].idempotencyKey).toBe(`reserve:${run.id}`);

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0.01);
    await assertCreditInvariants(user.id, 100);
  });

  it("throws InsufficientCreditsError and reserves nothing when balance is too low", async () => {
    const user = await makeUser("user_credits_2", 0.001);
    const { run } = await makeChatAndRun(user.id);

    await expect(
      prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 })),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const hold = await testDb.creditHold.findUnique({ where: { runId: run.id } });
    expect(hold).toBeNull();
    const ledger = await testDb.creditLedger.findMany({ where: { runId: run.id } });
    expect(ledger).toHaveLength(0);
    await assertCreditInvariants(user.id, 0.001);
  });

  it("release settles creditHeld back to zero and writes exactly one RELEASE row", async () => {
    const user = await makeUser("user_credits_3", 100);
    const { run } = await makeChatAndRun(user.id);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));

    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);

    const releaseRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RELEASE" } });
    expect(releaseRows).toHaveLength(1);
    await assertCreditInvariants(user.id, 100);
  });

  it("release is idempotent — a second call is a no-op, never a double refund", async () => {
    const user = await makeUser("user_credits_4", 100);
    const { run } = await makeChatAndRun(user.id);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));

    await prisma.$transaction((tx) => releaseHold(tx, run.id));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);
    const releaseRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RELEASE" } });
    expect(releaseRows).toHaveLength(1);
    await assertCreditInvariants(user.id, 100);
  });

  it("recordUsage writes a zero-cost USAGE ledger row carrying the metadata bag", async () => {
    const user = await makeUser("user_credits_5", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) =>
      recordUsage(tx, {
        runId: run.id,
        userId: user.id,
        turnIndex: 0,
        metadata: { resolvedModel: "upstage/solar-pro-3:free", promptTokens: 10, completionTokens: 20 },
      }),
    );

    const usageRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "USAGE" } });
    expect(usageRows).toHaveLength(1);
    expect(Number(usageRows[0].amount)).toBe(0);
    expect(usageRows[0].idempotencyKey).toBe(`usage:${run.id}:0`);
    expect(usageRows[0].metadata).toMatchObject({ resolvedModel: "upstage/solar-pro-3:free" });
    await assertCreditInvariants(user.id, 100);
  });

  it("reserveHold retried for the same runId is a no-op — no double debit, no P2002 escaping", async () => {
    const user = await makeUser("user_credits_reserve_retry", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await expect(
      prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 })),
    ).resolves.toBeUndefined();

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0.01);
    const ledger = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RESERVE" } });
    expect(ledger).toHaveLength(1);
    await assertCreditInvariants(user.id, 100);
  });

  it("recordUsage retried for the same (runId, turnIndex) is a no-op, not a thrown P2002", async () => {
    const user = await makeUser("user_credits_usage_retry", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) => recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { a: 1 } }));
    await expect(
      prisma.$transaction((tx) => recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { a: 1 } })),
    ).resolves.toBeUndefined();

    const usageRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "USAGE" } });
    expect(usageRows).toHaveLength(1);
    await assertCreditInvariants(user.id, 100);
  });

  it("a full turn (reserve -> usage @0 -> release) leaves exactly one RESERVE, one USAGE, one RELEASE row", async () => {
    const user = await makeUser("user_credits_6", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { resolvedModel: "x" } }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const ledger = await testDb.creditLedger.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((row) => row.kind)).toEqual(["RESERVE", "USAGE", "RELEASE"]);

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);
    expect(Number(refreshedUser.creditBalance)).toBe(100);
    await assertCreditInvariants(user.id, 100);
  });
});
