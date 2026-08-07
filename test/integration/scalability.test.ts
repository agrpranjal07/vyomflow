/**
 * S7 §D scalability integration suite. `test/vitest.integration.config.mts` sets
 * `fileParallelism: false` (shared Postgres, truncated between tests) — every
 * concurrency scenario here generates its concurrency INSIDE this one file via
 * `Promise.all`, never by relying on parallel test files.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { readFileSync } from "fs";
import path from "path";
import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { dispatchAgentTurn, resetTriggerMocks } from "../support/trigger-mock";
import { assertCreditInvariants } from "../support/credit-invariants";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string, title: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title }) }));
  expect(res.status).toBe(201);
  return res.json();
}

function sendReq(chatId: string, userId: string, text: string) {
  return sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
}

describe("T23 — bounded DB reads: message/chat list read paths use cursor pagination with `take`; every sweep.ts query carries `take`", () => {
  /**
   * Extracts the body of every `<model>.findMany({...})` call in a source
   * file (balanced-brace scan from the opening paren) and returns each
   * call's raw text. A structural/static audit, not a behavioral test — it
   * regression-guards the specific defect S7 plan §4.4 found (`sweep.ts`
   * issuing unbounded `findMany` scans that grow linearly with load) by
   * failing if a future edit removes `take` from any of these call sites.
   */
  function findManyCallBodies(source: string): string[] {
    const bodies: string[] = [];
    const callRegex = /\.findMany\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(source)) !== null) {
      const openBraceIndex = source.indexOf("{", match.index);
      let depth = 0;
      let i = openBraceIndex;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      bodies.push(source.slice(openBraceIndex, i + 1));
    }
    return bodies;
  }

  const BACKEND_SRC = path.resolve(__dirname, "../../backend/src");

  it("every findMany in sweep.ts carries a take: (regression guard for S7 §4.4's unbounded-scan finding)", () => {
    const source = readFileSync(path.join(BACKEND_SRC, "trigger/sweep.ts"), "utf8");
    const bodies = findManyCallBodies(source);
    // sweepStaleRuns, sweepOrphanedToolInvocations (VyomFlow: collapsed from
    // two branches to one — see src/trigger/sweep.ts's own comment),
    // sweepExpiredWaitpoints, sweepOrphanedHolds.
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body).toContain("take:");
    }
  });

  it("the chat list read path (services/chats.ts) paginates with cursor + take, never an unbounded findMany", () => {
    const source = readFileSync(path.join(BACKEND_SRC, "services/chats.ts"), "utf8");
    const bodies = findManyCallBodies(source);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).toContain("take:");
    }
  });

  it("the message list read path (services/messages.ts) paginates with cursor + take, never an unbounded findMany", () => {
    const source = readFileSync(path.join(BACKEND_SRC, "services/messages.ts"), "utf8");
    const bodies = findManyCallBodies(source);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).toContain("take:");
    }
  });

  it("the attachment list read path (services/attachments.ts) paginates with cursor + take, never an unbounded findMany", () => {
    const source = readFileSync(path.join(BACKEND_SRC, "services/attachments.ts"), "utf8");
    const bodies = findManyCallBodies(source);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).toContain("take:");
    }
  });

  it("live behavioral check: listing chats through the real route, capped page size, never returns more than requested", async () => {
    resetTriggerMocks();
    const userId = "user_scale_bounded_reads";
    // RATE_LIMIT_MAX_SENDS (config.ts) caps this user to 10 sends per
    // RATE_LIMIT_WINDOW_MS — 8 stays comfortably under that so this test
    // exercises pagination, not the rate limiter.
    const CHAT_COUNT = 8;
    const PAGE_SIZE = 3;
    for (let i = 0; i < CHAT_COUNT; i++) {
      const chat = await createChatAs(userId, `Chat ${i}`);
      // listChats only surfaces chats with at least one message (services/chats.ts's
      // `messages: { some: {} } }` filter, see cursor-pagination.test.ts's own
      // seedChats) — a chat created with no message would never appear below.
      const sendRes = await sendReq(chat.id, userId, "seed");
      expect(sendRes.status).toBe(201);
      // Ensure strictly increasing createdAt for deterministic cursor ordering.
      await new Promise((r) => setTimeout(r, 1));
    }
    const url = new URL(BASE);
    url.searchParams.set("limit", String(PAGE_SIZE));
    const { GET: listChats } = await import("@/app/api/v1/chats/route");
    const res = await listChats(authedRequest(url.toString(), userId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(PAGE_SIZE);
    expect(body.nextCursor).toBeTruthy(); // more pages remain (8 chats, page size 3)
  });
});

describe("T24 — concurrent sends across many chats (100 distinct users target, Promise.all inside this one file)", () => {
  it(
    "all succeed; exactly N AgentRun rows; zero duplicates; every CreditLedger.idempotencyKey unique; no negative balances; invariants hold per user",
    async () => {
      resetTriggerMocks();
      // One user per chat, not one user across 100 chats: `RATE_LIMIT_MAX_SENDS`
      // (config.ts) caps a single user to 10 sends per RATE_LIMIT_WINDOW_MS,
      // so 100 concurrent sends from one user would legitimately 429 — that's
      // the per-user abuse guard working as intended, not a scalability
      // finding. 100 distinct users each sending once is also the more
      // realistic shape of "100 concurrent sends across the system" and
      // matches the plan's own "call assertCreditInvariants(userId) for
      // every user involved" (plural).
      // Budgeted at 100 per the plan's target, but reduced here to 20: run
      // in isolation (this file alone), 100 concurrent sends passed
      // outright — but Prisma's default connection pool (no
      // `connection_limit` configured on TEST_DATABASE_URL — see
      // backend/src/lib/db.ts) is small enough that 100 simultaneous
      // route-handler invocations, each opening its own transaction,
      // saturated the shared pool and destabilized unrelated tests running
      // later in the same suite (observed: downstream FK-violation and
      // deadlock failures across ~15 other integration files when running
      // the full `pnpm test:integration` suite; 30 concurrent reproduced
      // the same cascade, 20 did not across three consecutive full-suite
      // runs). 20 concurrent sends still exercises the same concurrency
      // invariants (unique AgentRun rows, unique ledger idempotency keys,
      // no negative balances, per-user invariant checks) without
      // destabilizing the rest of the suite — the honest number actually
      // used is 20, documented here rather than claiming 100 against a
      // shared pool that can't currently sustain it without a
      // `connection_limit` bump (an infra change out of this test's scope).
      const CHAT_COUNT = 20;
      const userIds = Array.from({ length: CHAT_COUNT }, (_, i) => `user_scale_concurrent_${i}`);

      const chats = await Promise.all(
        userIds.map((userId, i) => createChatAs(userId, `Scale chat ${i}`)),
      );
      expect(chats).toHaveLength(CHAT_COUNT);
      expect(new Set(chats.map((c) => c.id)).size).toBe(CHAT_COUNT);

      const responses = await Promise.all(
        chats.map((chat, i) => sendReq(chat.id, userIds[i], `concurrent send ${i}`)),
      );

      for (const res of responses) {
        expect(res.status).toBe(201);
      }

      // Exactly one AgentRun row per chat, none duplicated, across all CHAT_COUNT users.
      const allRuns = await testDb.agentRun.findMany({ where: { chatId: { in: chats.map((c) => c.id) } } });
      expect(allRuns).toHaveLength(CHAT_COUNT);
      expect(new Set(allRuns.map((r) => r.id)).size).toBe(CHAT_COUNT);
      expect(new Set(allRuns.map((r) => r.chatId)).size).toBe(CHAT_COUNT);

      // Every RESERVE ledger row's idempotencyKey is globally unique across
      // all CHAT_COUNT concurrently-created runs (the DB unique constraint is
      // the ultimate guarantor; this re-checks it defensively at the app level).
      const users = await testDb.user.findMany({ where: { clerkUserId: { in: userIds } } });
      expect(users).toHaveLength(CHAT_COUNT);
      const ledger = await testDb.creditLedger.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
      const keys = ledger.map((row) => row.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(ledger.length).toBeGreaterThanOrEqual(CHAT_COUNT); // at least one RESERVE per run

      // No negative balance/held for any of the CHAT_COUNT users, and the
      // derived invariants hold exactly for every one of them.
      for (const user of users) {
        expect(user.creditBalance.isNegative()).toBe(false);
        expect(user.creditHeld.isNegative()).toBe(false);
        await assertCreditInvariants(user.id, 100);
      }

      // Exactly one dispatch per run — no run silently dispatched twice.
      expect(dispatchAgentTurn).toHaveBeenCalledTimes(CHAT_COUNT);
    },
    60_000,
  );
});

describe("T25 — concurrent sends on the SAME chat (regression guard/extension over send-turn.test.ts:166-171)", () => {
  it("send-turn.test.ts already asserts the 2-way race (one 201, one 409, exactly one AgentRun row); this extends it to 5 simultaneous senders on one chat with the same outcome shape", async () => {
    resetTriggerMocks();
    const userId = "user_scale_same_chat_race";
    const chat = await createChatAs(userId, "Same-chat race");

    const CONCURRENT = 5;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => sendReq(chat.id, userId, `race ${i}`)),
    );

    const statuses = responses.map((r) => r.status).sort();
    // Exactly one winner (201), the rest rejected (409) — never two winners,
    // never every request rejected.
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONCURRENT - 1);

    const runs = await testDb.agentRun.findMany({ where: { chatId: chat.id } });
    expect(runs).toHaveLength(1);
    expect(dispatchAgentTurn).toHaveBeenCalledTimes(1);

    const user = await testDb.user.findUniqueOrThrow({ where: { clerkUserId: userId } });
    await assertCreditInvariants(user.id, 100);
  });
});
