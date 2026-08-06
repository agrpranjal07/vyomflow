import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import {
  reserveHold,
  reserveAdditional,
  captureForTool,
  releaseHold,
  InsufficientCreditsError,
} from "@/services/credits";
import { testDb } from "../support/db";
import { assertCreditInvariants } from "../support/credit-invariants";

async function makeUser(clerkUserId: string, creditBalance = 100) {
  return testDb.user.create({ data: { clerkUserId, creditBalance } });
}

async function makeChatAndRun(ownerId: string) {
  const chat = await testDb.chat.create({ data: { ownerId, title: "t" } });
  const userMessage = await testDb.message.create({
    data: { chatId: chat.id, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  const run = await testDb.agentRun.create({
    data: {
      chatId: chat.id,
      idempotencyKey: `send:${chat.id}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
    },
  });
  return { chat, userMessage, run };
}

async function makeToolInvocation(agentRunId: string, toolCallId: string) {
  return testDb.toolInvocation.create({
    data: {
      agentRunId,
      turnIndex: 0,
      callIndex: 0,
      toolCallId,
      name: "merge_videos",
      nodeType: "merge_videos",
      input: {},
    },
  });
}

describe("credits — D2 incremental hold top-up and per-tool capture", () => {
  it("reserveAdditional grows the OPEN hold and debits creditHeld by the delta only", async () => {
    const user = await makeUser("user_tool_credits_1", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(Number(hold.amount)).toBeCloseTo(0.06, 6);

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBeCloseTo(0.06, 6);

    const reserveRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RESERVE" } });
    expect(reserveRows).toHaveLength(2);
    expect(reserveRows.map((r) => r.idempotencyKey).sort()).toEqual(
      [`reserve:${run.id}`, `reserve:${run.id}:${tool.id}`].sort(),
    );
    await assertCreditInvariants(user.id, 100);
  });

  it("reserveAdditional throws InsufficientCreditsError and reserves nothing when headroom is too small", async () => {
    const user = await makeUser("user_tool_credits_2", 0.02);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await expect(
      prisma.$transaction((tx) =>
        reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(Number(hold.amount)).toBeCloseTo(0.01, 6);
    await assertCreditInvariants(user.id, 0.02);
  });

  it("captureForTool settles exactly once at the reported amount, converting held into spent credit", async () => {
    const user = await makeUser("user_tool_credits_3", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.1 }),
    );
    // Capture at the tool's own reported creditUsed (0.05), not the 0.1 estimate.
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(99.95, 6);
    expect(Number(refreshedUser.creditHeld)).toBeCloseTo(0.06, 6);

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(Number(hold.capturedAmount)).toBeCloseTo(0.05, 6);

    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(1);
    expect(captureRows[0].idempotencyKey).toBe(`capture:${tool.id}`);
    await assertCreditInvariants(user.id, 100);
  });

  it("captureForTool is idempotent — a retried capture for the same invocation is a no-op", async () => {
    const user = await makeUser("user_tool_credits_4", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.1 }));

    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(99.95, 6);
    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(1);
    await assertCreditInvariants(user.id, 100);
  });

  it("releaseHold releases only the uncaptured remainder and marks the hold CAPTURED", async () => {
    const user = await makeUser("user_tool_credits_5", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.1 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    // 0.11 total held minus the 0.05 captured must be fully released.
    expect(Number(refreshedUser.creditHeld)).toBeCloseTo(0, 6);
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(99.95, 6);

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("CAPTURED");

    const releaseRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RELEASE" } });
    expect(releaseRows).toHaveLength(1);
    expect(Number(releaseRows[0].amount)).toBeCloseTo(0.06, 6);
    await assertCreditInvariants(user.id, 100);
  });

  it("releaseHold with zero captures still releases the full amount and marks RELEASED (S2 path unaffected)", async () => {
    const user = await makeUser("user_tool_credits_6", 100);
    const { run } = await makeChatAndRun(user.id);

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);
    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
    await assertCreditInvariants(user.id, 100);
  });

  // Bug fix (B): reserveAdditional now locks and re-checks the hold's own
  // status before growing it — a hold already finalized (RELEASED/CAPTURED)
  // by a concurrent cancel/finalize must never be topped up again, or the
  // increment would be added to creditHeld but never released (a permanent
  // credit leak).
  it("reserveAdditional throws and reserves nothing when the hold is no longer OPEN (already released)", async () => {
    const user = await makeUser("user_tool_credits_7", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const beforeUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(beforeUser.creditHeld)).toBe(0);

    await expect(
      prisma.$transaction((tx) =>
        reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // Nothing leaked: creditHeld stays at 0, the hold's amount/status
    // untouched, and no stray RESERVE ledger row for this tool invocation.
    const afterUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(afterUser.creditHeld)).toBe(0);
    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
    expect(Number(hold.amount)).toBeCloseTo(0.01, 6);
    const reserveRows = await testDb.creditLedger.findMany({
      where: { runId: run.id, kind: "RESERVE", toolInvocationId: tool.id },
    });
    expect(reserveRows).toHaveLength(0);
    await assertCreditInvariants(user.id, 100);
  });

  // S7 debt closure (§2.1/§9.5 T28): mirrors the `reserveAdditional` guard
  // test directly above — `captureForTool` carries the identical S6 fix
  // (§7.4) of locking and re-checking the hold's own status before writing,
  // but had zero automated coverage until now.
  it("captureForTool no-ops on a non-OPEN hold and mutates no balance/ledger state", async () => {
    const user = await makeUser("user_tool_credits_8", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.05 }));
    await prisma.$transaction((tx) => releaseHold(tx, run.id)); // hold is now RELEASED, not OPEN

    const beforeUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    const beforeHold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(beforeHold.status).toBe("RELEASED");

    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );

    const afterUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(afterUser.creditBalance)).toBe(Number(beforeUser.creditBalance));
    expect(Number(afterUser.creditHeld)).toBe(Number(beforeUser.creditHeld));

    const afterHold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(afterHold.status).toBe("RELEASED");
    expect(Number(afterHold.capturedAmount)).toBe(0);

    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(0);
    await assertCreditInvariants(user.id, 100);
  });
});
