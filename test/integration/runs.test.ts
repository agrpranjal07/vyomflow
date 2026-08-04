import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// "@trigger.dev/sdk" itself is aliased at the Vite config level
// (vitest.integration.config.mts) to ../support/trigger-sdk-mock, not
// vi.mock'd here — see that config's comment for why a vi.mock declared in
// this file can't intercept a package only installed in backend/node_modules.

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { GET as getRun } from "@/app/api/v1/runs/[runId]/route";
import { POST as cancelRun } from "@/app/api/v1/runs/[runId]/cancel/route";
import { GET as realtimeToken } from "@/app/api/v1/runs/[runId]/realtime-token/route";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";
import { cancelTriggerRun, resetTriggerMocks } from "../support/trigger-mock";
import { __setRetrieveResult, __resetTriggerSdkMock } from "../support/trigger-sdk-mock";
import { markRunning, reclaimRunningForRetry } from "@/server/agent/persist";
import { RUN_STALE_AFTER_MS, RUN_ORPHAN_HARD_TIMEOUT_MS, TRIGGER_RETRIEVE_TIMEOUT_MS, CANCEL_GRACE_MS } from "@/lib/config";

const BASE = "http://localhost/api/v1/chats";
const RUNS_BASE = "http://localhost/api/v1/runs";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

async function sendAs(userId: string, chatId: string) {
  const res = await sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
  return res.json();
}

beforeEach(() => {
  resetTriggerMocks();
  __resetTriggerSdkMock();
});

/** Backdates a run's updatedAt (bypassing @updatedAt auto-touch) and confirms its triggerRunId, mirroring the existing staleness-simulation pattern above. */
async function backdateRun(runId: string, staleMs: number, triggerRunId = `trigger_run_${runId}`) {
  await testDb.agentRun.update({ where: { id: runId }, data: { triggerRunId } });
  const staleUpdatedAt = new Date(Date.now() - staleMs);
  await testDb.$executeRawUnsafe(`UPDATE "agent_runs" SET "updatedAt" = $1 WHERE id = $2`, staleUpdatedAt, runId);
}

describe("GET /runs/:runId — ownership", () => {
  it("returns the run for its owner", async () => {
    const userId = "user_run_owner";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(run.id);
  });

  it("404s for a foreign user, byte-identical to a nonexistent runId — non-leaking", async () => {
    const owner = "user_run_owner2";
    const stranger = "user_run_stranger";
    const chat = await createChatAs(owner);
    const { run } = await sendAs(owner, chat.id);

    const foreignRes = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, stranger), {
      params: Promise.resolve({ runId: run.id }),
    });
    const neverExistedRes = await getRun(authedRequest(`${RUNS_BASE}/does-not-exist`, stranger), {
      params: Promise.resolve({ runId: "does-not-exist" }),
    });

    expect(foreignRes.status).toBe(404);
    expect(neverExistedRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual(await neverExistedRes.json());
  });

  it("401s an anonymous request", async () => {
    const userId = "user_run_anon";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const res = await getRun(anonymousRequest(`${RUNS_BASE}/${run.id}`), { params: Promise.resolve({ runId: run.id }) });
    expect(res.status).toBe(401);
  });
});

describe("GET /runs/:runId/realtime-token — ownership", () => {
  it("mints a token for the owner", async () => {
    const userId = "user_token_owner";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const res = await realtimeToken(authedRequest(`${RUNS_BASE}/${run.id}/realtime-token`, userId), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // realtime.runId is the Trigger.dev run id (what @trigger.dev/react-hooks'
    // useRealtimeStream/useRealtimeRun subscribe by), not this app's own
    // AgentRun.id — see frontend/src/hooks/use-active-run.ts.
    const row = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(body.runId).toBe(row.triggerRunId);
    expect(body.accessToken).toBeTruthy();
  });

  it("404s for a foreign user", async () => {
    const owner = "user_token_owner2";
    const stranger = "user_token_stranger";
    const chat = await createChatAs(owner);
    const { run } = await sendAs(owner, chat.id);

    const res = await realtimeToken(authedRequest(`${RUNS_BASE}/${run.id}/realtime-token`, stranger), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /runs/:runId/cancel", () => {
  it("cancels a queued run directly (onCancel never fires for queued) — status becomes cancelled, hold released", async () => {
    const userId = "user_cancel_queued";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const res = await cancelRun(authedRequest(`${RUNS_BASE}/${run.id}/cancel`, userId, { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("cancelled");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
    const releaseRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RELEASE" } });
    expect(releaseRows).toHaveLength(1);
  });

  it("cancels a running run by setting cancelRequestedAt and calling the trigger cancel seam — status stays running (derived 'stopping')", async () => {
    const userId = "user_cancel_running";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });

    const res = await cancelRun(authedRequest(`${RUNS_BASE}/${run.id}/cancel`, userId, { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(body.cancelRequestedAt).not.toBeNull();
    expect(cancelTriggerRun).toHaveBeenCalledTimes(1);
  });

  it("double-cancel is idempotent — a repeat call on an already-terminal run is a no-op, never an error", async () => {
    const userId = "user_cancel_double";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const first = await cancelRun(authedRequest(`${RUNS_BASE}/${run.id}/cancel`, userId, { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(first.status).toBe(200);

    const second = await cancelRun(authedRequest(`${RUNS_BASE}/${run.id}/cancel`, userId, { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.status).toBe("cancelled");

    // Still exactly one RELEASE row — a double-finalize never double-refunds.
    const releaseRows = await testDb.creditLedger.findMany({ where: { runId: run.id, kind: "RELEASE" } });
    expect(releaseRows).toHaveLength(1);
  });

  it("404s a cancel attempt from a foreign user", async () => {
    const owner = "user_cancel_owner";
    const stranger = "user_cancel_stranger";
    const chat = await createChatAs(owner);
    const { run } = await sendAs(owner, chat.id);

    const res = await cancelRun(authedRequest(`${RUNS_BASE}/${run.id}/cancel`, stranger, { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("reconciler — GET /runs/:runId finalizes a stale run", () => {
  it("a stale queued run with no confirmed triggerRunId is finalized as failed", async () => {
    const userId = "user_reconcile_1";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    // Simulate: dispatch never confirmed (triggerRunId cleared) and the
    // row has been sitting untouched well past the staleness threshold.
    const staleUpdatedAt = new Date(Date.now() - 10 * 60_000);
    await testDb.agentRun.update({
      where: { id: run.id },
      data: { triggerRunId: null, updatedAt: staleUpdatedAt },
    });
    // updatedAt has @updatedAt auto-touch; force it back to the stale value via raw SQL.
    await testDb.$executeRawUnsafe(`UPDATE "agent_runs" SET "updatedAt" = $1 WHERE id = $2`, staleUpdatedAt, run.id);

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("dispatch_unconfirmed");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
  });

  it("a fresh (non-stale) queued run is left untouched", async () => {
    const userId = "user_reconcile_2";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("queued");
  });

  it("RUN_ORPHAN_HARD_TIMEOUT_MS backstop: fails a run Trigger.dev still reports active for once it's been stale far longer than any real turn", async () => {
    const userId = "user_reconcile_hard_timeout";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await backdateRun(run.id, RUN_ORPHAN_HARD_TIMEOUT_MS + 60_000);
    __setRetrieveResult(async () => ({ status: "EXECUTING" }));

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("orphaned_run_timeout");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
  });

  it(
    "TRIGGER_RETRIEVE_TIMEOUT_MS race: a hung retrieve call is raced against its own deadline and treated as unreachable, leaving a run under the hard timeout untouched",
    async () => {
      const userId = "user_reconcile_retrieve_timeout";
      const chat = await createChatAs(userId);
      const { run } = await sendAs(userId, chat.id);
      // Stale enough to enter the retrieve branch, nowhere near the hard
      // timeout — isolates the deadline race from the hard-timeout backstop.
      await backdateRun(run.id, RUN_STALE_AFTER_MS + 60_000);
      // Never resolves — reconcileIfStale's own Promise.race against
      // TRIGGER_RETRIEVE_TIMEOUT_MS is what has to save this call, not the
      // mock. Real (bounded, ~10s) wait — matches the actual production
      // deadline this branch exists to enforce.
      __setRetrieveResult(() => new Promise(() => {}));

      const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
      const body = await res.json();
      expect(body.status).toBe("queued");
      expect(body.errorCode).toBeNull();
    },
    TRIGGER_RETRIEVE_TIMEOUT_MS + 10_000,
  );

  it("reconciliation_incomplete: Trigger.dev reports the run terminal but our own row never got the finalize write", async () => {
    const userId = "user_reconcile_incomplete";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await backdateRun(run.id, RUN_STALE_AFTER_MS + 60_000);
    __setRetrieveResult(async () => ({ status: "COMPLETED" }));

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.errorCode).toBe("reconciliation_incomplete");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
  });
});

describe("reconciler — cancel-on-dead-worker fast path resolves within CANCEL_GRACE_MS (T34)", () => {
  it("a run whose cancel request has sat unresolved past CANCEL_GRACE_MS is reconciled, even though it's nowhere near RUN_STALE_AFTER_MS on its own", async () => {
    const userId = "user_reconcile_cancel_grace";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    // Fresh updatedAt (well under RUN_STALE_AFTER_MS by itself) but a
    // cancelRequestedAt that's already past CANCEL_GRACE_MS — isolates the
    // fast cancel-grace path from reconcileIfStale's general staleness
    // guard, which the other `reconciler` describe block above already
    // covers.
    await testDb.agentRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        triggerRunId: `trigger_run_${run.id}`,
        cancelRequestedAt: new Date(Date.now() - (CANCEL_GRACE_MS + 1_000)),
      },
    });
    await testDb.$executeRawUnsafe(`UPDATE "agent_runs" SET "updatedAt" = $1 WHERE id = $2`, new Date(), run.id);
    __setRetrieveResult(async () => ({ status: "CANCELED" }));

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("cancelled");

    const hold = await testDb.creditHold.findUniqueOrThrow({ where: { runId: run.id } });
    expect(hold.status).toBe("RELEASED");
  });

  it("a run with no cancel request and fresh updatedAt is left untouched (the grace path never fires without a pending cancel)", async () => {
    const userId = "user_reconcile_no_cancel_grace";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await testDb.agentRun.update({ where: { id: run.id }, data: { status: "running", triggerRunId: `trigger_run_${run.id}` } });

    const res = await getRun(authedRequest(`${RUNS_BASE}/${run.id}`, userId), { params: Promise.resolve({ runId: run.id }) });
    const body = await res.json();
    expect(body.status).toBe("running");
  });
});

describe("reclaimRunningForRetry — retry of a crashed attempt with zero persisted progress (hardening pass)", () => {
  it("reclaims a running row whose lastStreamIndex is still -1", async () => {
    const userId = "user_reclaim_1";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    // Simulate the first attempt: markRunning claimed it, then the worker
    // crashed before persisting any delta — status is "running" but
    // lastStreamIndex is untouched at -1.
    const claimedFirst = await markRunning(run.id, "trigger_run_attempt_1");
    expect(claimedFirst).toBe(true);

    // Trigger.dev's retry re-invokes with a fresh attempt — previously this
    // scenario had no claim path at all (markRunning only matches
    // "queued"), silently no-op'ing and stranding the run in "running"
    // forever with no thrown error to trigger a further retry.
    const reclaimed = await reclaimRunningForRetry(run.id, "trigger_run_attempt_2");
    expect(reclaimed).toBe(true);

    const refreshed = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshed.status).toBe("running");
    expect(refreshed.triggerRunId).toBe("trigger_run_attempt_2");
  });

  it("refuses to reclaim once real progress has been persisted (lastStreamIndex > -1) — never races a writer that already streamed", async () => {
    const userId = "user_reclaim_2";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await markRunning(run.id, "trigger_run_progress");
    await testDb.agentRun.update({ where: { id: run.id }, data: { lastStreamIndex: 3 } });

    const reclaimed = await reclaimRunningForRetry(run.id, "trigger_run_retry");
    expect(reclaimed).toBe(false);

    const refreshed = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshed.triggerRunId).toBe("trigger_run_progress"); // untouched
  });

  it("refuses to reclaim a queued (never-started) row — that's markRunning's job, not this one's", async () => {
    const userId = "user_reclaim_3";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);

    const reclaimed = await reclaimRunningForRetry(run.id, "trigger_run_x");
    expect(reclaimed).toBe(false);
  });

  it("refuses to reclaim a running row with a pending cancellation, even with zero persisted progress (hardening pass)", async () => {
    const userId = "user_reclaim_4";
    const chat = await createChatAs(userId);
    const { run } = await sendAs(userId, chat.id);
    await markRunning(run.id, "trigger_run_cancel_pending");
    // Mirrors the cancel route: sets cancelRequestedAt on a running row
    // without touching status/lastStreamIndex — the crashed attempt never
    // got to observe the abort signal.
    await testDb.agentRun.update({ where: { id: run.id }, data: { cancelRequestedAt: new Date() } });

    const reclaimed = await reclaimRunningForRetry(run.id, "trigger_run_retry");
    expect(reclaimed).toBe(false);

    const refreshed = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(refreshed.triggerRunId).toBe("trigger_run_cancel_pending"); // untouched — a retry must not silently resume a cancelled run
  });
});
