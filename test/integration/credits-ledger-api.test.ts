import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getLedger } from "@/app/api/v1/me/credits/ledger/route";
import { reserveHold, releaseHold, recordUsage, captureForTool } from "@/services/credits";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/me/credits/ledger";

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

async function fetchAllPages(userId: string, pageSize: number) {
  const seen: { id: string; kind: string }[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const url = new URL(BASE);
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await getLedger(authedRequest(url.toString(), userId));
    const body = await res.json();
    seen.push(...body.items);
    cursor = body.nextCursor;
    guard += 1;
  } while (cursor && guard < 20);
  return seen;
}

describe("GET /api/v1/me/credits/ledger", () => {
  it("returns only net-debited (CAPTURE/USAGE) entries, newest-first, with amount as a string", async () => {
    // credits.md "`/usage` — Action/'View details' drill-down gap" fold-in:
    // this endpoint backs UsageDetailedView's per-tool record table only,
    // and must show one row per net-debited event — not every RESERVE/
    // CAPTURE/RELEASE step of the same run as its own top-level row (those
    // remain visible, unfiltered, via the "Usage details" modal's step
    // breakdown / listCreditLedgerByRun).
    const user = await makeUser("user_ledger_1", 100);
    const run = await makeChatAndRun(user.id, 1);
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 5 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: {} }),
    );
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const res = await getLedger(authedRequest(BASE, "user_ledger_1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the USAGE row is net-debited — RESERVE/RELEASE are hold
    // bookkeeping and must not appear as their own list rows here.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("USAGE");
    for (const item of body.items) {
      expect(typeof item.amount).toBe("string");
      expect(typeof item.id).toBe("string");
      expect(typeof item.createdAt).toBe("string");
      expect(item.runId).toBe(run.id);
    }
  });

  it("per-caller isolation: never returns another user's ledger rows", async () => {
    const userA = await makeUser("user_ledger_a", 100);
    const userB = await makeUser("user_ledger_b", 100);
    const runA = await makeChatAndRun(userA.id, 1);
    const runB = await makeChatAndRun(userB.id, 1);
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: runA.id, userId: userA.id, turnIndex: 0, metadata: {} }),
    );
    await prisma.$transaction((tx) =>
      recordUsage(tx, { runId: runB.id, userId: userB.id, turnIndex: 0, metadata: {} }),
    );

    const res = await getLedger(authedRequest(BASE, "user_ledger_a"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].runId).toBe(runA.id);
  });

  it("cursor pagination actually pages: no duplicates, no gaps across a page boundary", async () => {
    const user = await makeUser("user_ledger_paged", 1000);
    const run = await makeChatAndRun(user.id, 1);
    // 7 USAGE rows (zero-cost, no balance interaction needed) — strictly
    // increasing createdAt via the sequential await, same determinism
    // trick as cursor-pagination.test.ts's seedChats.
    for (let i = 0; i < 7; i++) {
      await prisma.$transaction((tx) =>
        recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: i, metadata: { i } }),
      );
      await new Promise((r) => setTimeout(r, 2));
    }

    const seen = await fetchAllPages("user_ledger_paged", 3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((s) => s.id)).size).toBe(7);

    // First page (limit 3) should return the 3 most-recently-created rows.
    const firstPageRes = await getLedger(authedRequest(`${BASE}?limit=3`, "user_ledger_paged"));
    const firstPage = await firstPageRes.json();
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPageRes = await getLedger(
      authedRequest(`${BASE}?limit=3&cursor=${encodeURIComponent(firstPage.nextCursor)}`, "user_ledger_paged"),
    );
    const secondPage = await secondPageRes.json();
    // No overlap with the first page.
    const firstIds = new Set(firstPage.items.map((i: { id: string }) => i.id));
    for (const item of secondPage.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  it("excludes RESERVE/RELEASE (hold bookkeeping) and links toolInvocationId on the CAPTURE row it does return", async () => {
    const user = await makeUser("user_ledger_kinds", 100);
    const run = await makeChatAndRun(user.id, 1);
    const invocation = await testDb.toolInvocation.create({
      data: {
        agentRunId: run.id,
        turnIndex: 0,
        callIndex: 0,
        toolCallId: "tu_1",
        name: "crop_image",
        nodeType: "crop_image",
        input: {},
        status: "COMPLETED",
      },
    });
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 4 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: invocation.id, amount: 4 }),
    );
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    const res = await getLedger(authedRequest(BASE, "user_ledger_kinds"));
    const body = await res.json();
    const kinds = body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toEqual(["CAPTURE"]);
    const capture = body.items[0];
    expect(capture.toolInvocationId).toBe(invocation.id);
  });

  it("scopes to one tool group via the optional ?tool= filter (S7 /usage Detailed View)", async () => {
    const user = await makeUser("user_ledger_tool_filter", 100);
    const run = await makeChatAndRun(user.id, 1);
    const crop = await testDb.toolInvocation.create({
      data: { agentRunId: run.id, turnIndex: 0, callIndex: 0, toolCallId: "tu_crop", name: "crop_image", nodeType: "crop_image", input: {} },
    });
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 5 }));
    await new Promise((r) => setTimeout(r, 2));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: crop.id, amount: 5 }),
    );
    await new Promise((r) => setTimeout(r, 2));
    // Bare LLM usage row — no toolInvocationId, groups under "none".
    await prisma.$transaction((tx) =>
      testDb.creditLedger.create({
        data: { userId: user.id, runId: run.id, kind: "USAGE", amount: 0, idempotencyKey: "usage:manual:1" },
      }),
    );

    const cropRes = await getLedger(authedRequest(`${BASE}?tool=crop_image`, "user_ledger_tool_filter"));
    const cropBody = await cropRes.json();
    expect(cropBody.items).toHaveLength(1);
    expect(cropBody.items[0].kind).toBe("CAPTURE");
    expect(cropBody.items[0].toolInvocationId).toBe(crop.id);

    // "none" scope returns net-debited rows with no toolInvocationId — just
    // the manually-created USAGE row; the untagged RESERVE row from the
    // hold lifecycle above is bookkeeping, not a net-debited record, and is
    // excluded here (still visible via the run's step breakdown).
    const noneRes = await getLedger(authedRequest(`${BASE}?tool=none`, "user_ledger_tool_filter"));
    const noneBody = await noneRes.json();
    expect(noneBody.items).toHaveLength(1);
    expect(noneBody.items[0].toolInvocationId).toBeNull();
    expect(noneBody.items[0].kind).toBe("USAGE");
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getLedger(anonymousRequest(BASE));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
