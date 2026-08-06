import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { testDb } from "../support/db";
import { reliabilitySweep } from "@/trigger/sweep";
import { reserveHold } from "@/services/credits";
import { RUN_STALE_AFTER_MS, CANCEL_GRACE_MS, TOOL_ORPHAN_TIMEOUT_MS } from "@/lib/config";
import { reconcileIfStale } from "@/services/runs";

// `schedules.task` is mocked as a pass-through (../support/trigger-sdk-mock),
// so the object exported by src/trigger/sweep.ts still carries a callable
// `.run` — the same way src/trigger/turn.ts's task body is invoked directly
// in tool-orchestration.test.ts, just without a standalone exported function
// to import (sweep.ts doesn't export one).
const runSweep = () => (reliabilitySweep as unknown as { run: () => Promise<void> }).run();

async function makeUser(clerkUserId: string, creditBalance = 100) {
  return testDb.user.create({ data: { clerkUserId, creditBalance } });
}

async function makeChatAndRun(ownerId: string, overrides: Partial<{ status: string; assistantMessageId: string | null }> = {}) {
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
      ...(overrides.status ? { status: overrides.status as never } : {}),
    },
  });
  return { chat, userMessage, run };
}

/** Bypasses the @updatedAt auto-touch trigger, mirroring runs.test.ts's own backdateRun helper. */
async function setUpdatedAt(table: string, id: string, when: Date) {
  await testDb.$executeRawUnsafe(`UPDATE "${table}" SET "updatedAt" = $1 WHERE id = $2`, when, id);
}

describe("reliabilitySweep — stale-run WHERE and reconcileIfStale must never diverge (T27)", () => {
  it("a run just under RUN_STALE_AFTER_MS, with no cancel request, is excluded by both the sweep's WHERE and reconcileIfStale's own in-memory guard", async () => {
    const user = await makeUser("user_sweep_t27");
    const { run } = await makeChatAndRun(user.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "running", triggerRunId: `trig_${run.id}` } });
    // 5 seconds under the cutoff — comfortably "just under" without being
    // flaky against real wall-clock time elapsed during the test itself.
    await setUpdatedAt("agent_runs", run.id, new Date(Date.now() - (RUN_STALE_AFTER_MS - 5_000)));

    await runSweep();

    const afterSweep = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterSweep.status).toBe("running"); // sweep's WHERE never selected it

    // Same conclusion from the in-memory guard the sweep itself relies on
    // being in agreement with — proves the two checks don't diverge.
    const guarded = await reconcileIfStale(afterSweep);
    expect(guarded.status).toBe("running");
    expect(guarded.updatedAt.getTime()).toBe(afterSweep.updatedAt.getTime()); // untouched
  });

  it("a run past RUN_STALE_AFTER_MS with no confirmed triggerRunId IS picked up and reconciled by the sweep", async () => {
    const user = await makeUser("user_sweep_t27b");
    const { run } = await makeChatAndRun(user.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "running", triggerRunId: null } });
    await setUpdatedAt("agent_runs", run.id, new Date(Date.now() - (RUN_STALE_AFTER_MS + 5_000)));

    await runSweep();

    const afterSweep = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterSweep.status).toBe("failed");
    expect(afterSweep.errorCode).toBe("dispatch_unconfirmed");
  });

  it("a cancel-requested run past CANCEL_GRACE_MS but well under RUN_STALE_AFTER_MS is still picked up (the fast cancel path, mirrors T34)", async () => {
    const user = await makeUser("user_sweep_t27c");
    const { run } = await makeChatAndRun(user.id);
    await testDb.agentRun.update({
      where: { id: run.id },
      data: { status: "running", triggerRunId: null, cancelRequestedAt: new Date(Date.now() - (CANCEL_GRACE_MS + 1_000)) },
    });
    // Fresh updatedAt — nowhere near RUN_STALE_AFTER_MS on its own.
    await setUpdatedAt("agent_runs", run.id, new Date());

    await runSweep();

    const afterSweep = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterSweep.status).toBe("failed");
    expect(afterSweep.errorCode).toBe("dispatch_unconfirmed");
  });
});

describe("reliabilitySweep — orphaned stale-OPEN-hold release (§B.11, T29)", () => {
  it("releases an OPEN hold whose run already reached a terminal status", async () => {
    const user = await makeUser("user_sweep_t29");
    const { run } = await makeChatAndRun(user.id);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.05 }));
    // Simulate a finalize path that, for whatever reason, didn't release the
    // hold itself — the exact scenario sweepOrphanedHolds exists to backstop.
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "completed", finishedAt: new Date() } });

    const beforeUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(beforeUser.creditHeld)).toBeCloseTo(0.05, 6);

    await runSweep();

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
    const afterUser = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(afterUser.creditHeld)).toBe(0);
  });

  it("leaves an OPEN hold on a still-active run untouched", async () => {
    const user = await makeUser("user_sweep_t29b");
    const { run } = await makeChatAndRun(user.id);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.05 }));

    await runSweep();

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("OPEN");
  });
});

describe("reliabilitySweep — waitpoint expiry (C18, T30)", () => {
  it("expires a PENDING waitpoint past expiresAt, releases the hold, and fails the run with waitpoint_expired", async () => {
    const user = await makeUser("user_sweep_t30");
    const { run } = await makeChatAndRun(user.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "waiting" } });
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 0.05 }));
    const waitpoint = await testDb.waitpoint.create({
      data: {
        agentRunId: run.id,
        kind: "CLARIFICATION",
        requestPayload: { question: "Which one?" },
        triggerTokenId: `wpt_expiry_${run.id}`,
        expiresAt: new Date(Date.now() - 1_000), // already past
      },
    });

    await runSweep();

    const expiredWaitpoint = await testDb.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(expiredWaitpoint.status).toBe("EXPIRED");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");

    const finalRun = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalRun.status).toBe("failed");
    expect(finalRun.errorCode).toBe("waitpoint_expired");
  });

  it("leaves a PENDING waitpoint not yet past expiresAt untouched", async () => {
    const user = await makeUser("user_sweep_t30b");
    const { run } = await makeChatAndRun(user.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "waiting" } });
    const waitpoint = await testDb.waitpoint.create({
      data: {
        agentRunId: run.id,
        kind: "CLARIFICATION",
        requestPayload: { question: "Which one?" },
        triggerTokenId: `wpt_not_expired_${run.id}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await runSweep();

    const stillPending = await testDb.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(stillPending.status).toBe("PENDING");
    const stillWaiting = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stillWaiting.status).toBe("waiting");
  });
});

// sweep.ts's old two-branch split (reconcile via a remote provider GET when
// a remote run id was set; log-only when it wasn't) collapsed to one — all
// three real tools now run in-process, so a
// row stuck non-terminal past the orphan timeout has no remote run to
// reconcile against; it means the owning worker died mid-execute, and is
// unconditionally failed closed rather than re-executed (its side effects
// are not known to be safe to redo).
describe("reliabilitySweep — orphaned ToolInvocation dispatch (§7.3 item 2/3, C23, T32)", () => {
  async function makeStuckInvocation(agentRunId: string, status: "DISPATCHING" | "RUNNING" | "QUEUED") {
    const invocation = await testDb.toolInvocation.create({
      data: {
        agentRunId,
        turnIndex: 0,
        callIndex: 0,
        toolCallId: "call_1",
        name: "merge_videos",
        nodeType: "merge_videos",
        input: {},
        status,
      },
    });
    await setUpdatedAt("tool_invocations", invocation.id, new Date(Date.now() - (TOOL_ORPHAN_TIMEOUT_MS + 5_000)));
    return invocation;
  }

  it.each(["DISPATCHING", "RUNNING", "QUEUED"] as const)(
    "a row stuck %s past TOOL_ORPHAN_TIMEOUT_MS is settled FAILED with errorCode orphaned, never re-executed",
    async (status) => {
      const user = await makeUser(`user_sweep_t32_${status}`);
      const { run } = await makeChatAndRun(user.id);
      const invocation = await makeStuckInvocation(run.id, status);

      await runSweep();

      const reconciled = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
      expect(reconciled.status).toBe("FAILED");
      expect(reconciled.errorCode).toBe("orphaned");
    },
  );

  it("leaves a row well under TOOL_ORPHAN_TIMEOUT_MS untouched", async () => {
    const user = await makeUser("user_sweep_t32_fresh");
    const { run } = await makeChatAndRun(user.id);
    const invocation = await testDb.toolInvocation.create({
      data: {
        agentRunId: run.id,
        turnIndex: 0,
        callIndex: 0,
        toolCallId: "call_1",
        name: "merge_videos",
        nodeType: "merge_videos",
        input: {},
        status: "RUNNING",
      },
    });

    await runSweep();

    const untouched = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(untouched.status).toBe("RUNNING");
  });
});
