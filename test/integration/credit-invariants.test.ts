/**
 * S7 plan §9.3 (T12–T17) — end-to-end credit-lifecycle scenarios, each
 * closed out with `assertCreditInvariants`. Most of the individual
 * settlement behaviors here are already regression-guarded by
 * `credits.test.ts` / `tool-credits.test.ts`; the net-new value is running
 * the shared invariant helper at the end of each scenario, which nothing
 * does today (plan §9.1).
 */
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import {
  reserveHold,
  reserveAdditional,
  captureForTool,
  releaseHold,
  recordUsage,
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

describe("credit invariants (S7 §9.3)", () => {
  it("T12: full successful turn with one tool — one RESERVE, one additional RESERVE, one CAPTURE, one RELEASE, one USAGE", async () => {
    const user = await makeUser("user_ci_t12", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.1 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.1 }),
    );
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { resolvedModel: "x" } }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const ledger = await testDb.creditLedger.findMany({ where: { runId: run.id } });
    expect(ledger.filter((r) => r.kind === "RESERVE")).toHaveLength(2);
    expect(ledger.filter((r) => r.kind === "CAPTURE")).toHaveLength(1);
    expect(ledger.filter((r) => r.kind === "RELEASE")).toHaveLength(1);
    expect(ledger.filter((r) => r.kind === "USAGE")).toHaveLength(1);

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("CAPTURED");

    await assertCreditInvariants(user.id, 100);
  });

  it("T13: cancelled mid-tool — completed tool's capture retained, remainder released, hold CAPTURED", async () => {
    const user = await makeUser("user_ci_t13", 100);
    const { run } = await makeChatAndRun(user.id);
    const toolA = await makeToolInvocation(run.id, "call_a");
    const toolB = await makeToolInvocation(run.id, "call_b");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    // Tool A dispatched, completed, and captured before cancellation.
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: toolA.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: toolA.id, amount: 0.05 }),
    );
    // Tool B was only estimated/reserved for, never completed, when the
    // cancel arrives — its reservation must come back as part of release.
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: toolB.id, amount: 0.2 }),
    );

    // Cancel: finalize releases whatever remains uncaptured.
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("CAPTURED");
    expect(Number(hold.capturedAmount)).toBeCloseTo(0.05, 6);

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(99.95, 6);

    await assertCreditInvariants(user.id, 100);
  });

  it("T14: mid-turn exhaustion — completed tools captured at actual, remainder released, no negative balance", async () => {
    const user = await makeUser("user_ci_t14", 0.2);
    const { run } = await makeChatAndRun(user.id);
    const toolA = await makeToolInvocation(run.id, "call_a");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: toolA.id, amount: 0.15 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: toolA.id, amount: 0.12 }),
    );

    // Headroom is now too small for a second tool — the caller must stop
    // dispatching further tools and terminate the run rather than proceed.
    const toolB = await makeToolInvocation(run.id, "call_b");
    await expect(
      prisma.$transaction((tx) =>
        reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: toolB.id, amount: 0.5 }),
      ),
    ).rejects.toThrow();

    // Run terminates: release whatever remains of the hold.
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditHeld)).toBe(0);
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(0.08, 6);
    expect(refreshedUser.creditBalance.isNegative()).toBe(false);
    expect(refreshedUser.creditHeld.isNegative()).toBe(false);

    await assertCreditInvariants(user.id, 0.2);
  });

  it("T15: duplicate settlement inert — replaying every settlement adds no ledger row, changes no balance", async () => {
    const user = await makeUser("user_ci_t15", 100);
    const { run } = await makeChatAndRun(user.id);
    const tool = await makeToolInvocation(run.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { a: 1 } }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const before = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    const ledgerBefore = await testDb.creditLedger.findMany({ where: { runId: run.id } });

    // Replay every settlement with the exact same keys.
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await expect(
      prisma.$transaction((tx) =>
        reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
      ),
    ).rejects.toThrow(); // hold no longer OPEN — correctly refuses rather than silently no-op-ing
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: tool.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: { a: 1 } }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const after = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    const ledgerAfter = await testDb.creditLedger.findMany({ where: { runId: run.id } });

    expect(after.creditBalance.equals(before.creditBalance)).toBe(true);
    expect(after.creditHeld.equals(before.creditHeld)).toBe(true);
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);

    await assertCreditInvariants(user.id, 100);
  });

  // Restated: "capture iff the tool completed successfully, at its fixed
  // per-tool estimate; capture nothing on any failure path" —
  // provider-neutral, not "iff the tool reports creditUsed > 0" (an earlier
  // wording this test used to encode, which is exactly the wording that let
  // a real bug ship: tool.ts's
  // asset_upload_failed path once reported a positive creditUsedApp on a
  // FAILED run, and turn.ts's capture gate keyed only on the amount).
  //
  // reserveHold/reserveAdditional/captureForTool/releaseHold in
  // services/credits.ts are mechanics, not policy — they will capture
  // whatever amount they're told to, on any hold status transition that's
  // still OPEN. The *policy* ("never call captureForTool for a FAILED
  // invocation, regardless of amount") lives in turn.ts's dispatchOne, and
  // assertCreditInvariants below is structurally blind to a policy
  // violation there — a capture on a failed tool still satisfies all of its
  // balance/held/idempotency invariants. The real enforcement of this
  // policy is exercised end-to-end against the actual dispatchOne code path
  // in tool-orchestration.test.ts's "never captures credit for a FAILED
  // tool run, even if the task result reports a positive creditUsedApp".
  // This test covers the mechanics half only: a FAILED invocation's hold is
  // released with no capture ever attempted for it, alongside a sibling
  // invocation that *does* complete and capture normally on the same hold.
  it("T16: failed tool billing — no capture is attempted for a FAILED invocation, even when a sibling on the same hold captures normally", async () => {
    const user = await makeUser("user_ci_t16", 100);
    const { run } = await makeChatAndRun(user.id);
    const failed = await makeToolInvocation(run.id, "call_failed");
    const completed = await makeToolInvocation(run.id, "call_completed");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.01 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: failed.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: completed.id, amount: 0.05 }),
    );

    // `failed` settles FAILED — the caller policy is to never call
    // captureForTool for it, at any amount, so no capture call is made here.
    // `completed` settles COMPLETED and captures its estimate normally.
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: completed.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const captureRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "CAPTURE" } });
    expect(captureRows).toHaveLength(1);
    expect(captureRows[0].toolInvocationId).toBe(completed.id);
    expect(Number(captureRows[0].amount)).toBeCloseTo(0.05, 6);

    const refreshedUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(refreshedUser.creditBalance)).toBeCloseTo(99.95, 6);
    expect(Number(refreshedUser.creditHeld)).toBe(0);

    await assertCreditInvariants(user.id, 100);
  });

  it("T17: hold status lifecycle — OPEN -> CAPTURED if any capture, else RELEASED", async () => {
    const userA = await makeUser("user_ci_t17_captured", 100);
    const { run: runA } = await makeChatAndRun(userA.id);
    const toolA = await makeToolInvocation(runA.id, "call_1");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: runA.id, userId: userA.id, amount: 0.01 }));
    let holdA = await testDb.creditHold.findUniqueOrThrow({ where: { runId: runA.id } });
    expect(holdA.status).toBe("OPEN");

    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: runA.id, userId: userA.id, toolInvocationId: toolA.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: runA.id, userId: userA.id, toolInvocationId: toolA.id, amount: 0.05 }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, runA.id));

    holdA = await testDb.creditHold.findUniqueOrThrow({ where: { runId: runA.id } });
    expect(holdA.status).toBe("CAPTURED");
    await assertCreditInvariants(userA.id, 100);

    const userB = await makeUser("user_ci_t17_released", 100);
    const { run: runB } = await makeChatAndRun(userB.id);

    await prisma.$transaction((tx) => reserveHold(tx, { runId: runB.id, userId: userB.id, amount: 0.01 }));
    await prisma.$transaction((tx) => releaseHold(tx, runB.id));

    const holdB = await testDb.creditHold.findUniqueOrThrow({ where: { runId: runB.id } });
    expect(holdB.status).toBe("RELEASED");
    await assertCreditInvariants(userB.id, 100);
  });
});
