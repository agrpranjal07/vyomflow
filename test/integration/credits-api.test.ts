import { describe, it, expect } from "vitest";

import { GET as getCredits } from "@/app/api/v1/me/credits/route";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";
import { prisma } from "@/lib/db";
import { reserveHold } from "@/services/credits";

const BASE = "http://localhost/api/v1/me/credits";

async function makeUser(clerkUserId: string, creditBalance = 100) {
  return testDb.user.create({ data: { clerkUserId, creditBalance } });
}

describe("GET /api/v1/me/credits", () => {
  it("T1 — returns balance/held/available as strings, available = balance - held", async () => {
    const user = await makeUser("user_credits_api_1", 42.5);

    const res = await getCredits(authedRequest(BASE, "user_credits_api_1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.balance).toBe("string");
    expect(typeof body.held).toBe("string");
    expect(typeof body.available).toBe("string");
    expect(Number(body.balance)).toBe(42.5);
    expect(Number(body.held)).toBe(0);
    expect(Number(body.available)).toBe(Number(body.balance) - Number(body.held));
    void user;
  });

  it("T2 — per-caller only: A's token never returns B's balance, no userId param honored", async () => {
    await makeUser("user_credits_api_a", 10);
    await makeUser("user_credits_api_b", 999);

    const res = await getCredits(authedRequest(`${BASE}?userId=user_credits_api_b`, "user_credits_api_a"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.balance)).toBe(10);
  });

  it("T3 — held reflects an open hold mid-run; available down by exactly the admission", async () => {
    const user = await makeUser("user_credits_api_3", 100);
    const chat = await testDb.chat.create({ data: { ownerId: user.id, title: "t" } });
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
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 5 }));

    const res = await getCredits(authedRequest(BASE, "user_credits_api_3"));
    const body = await res.json();
    expect(Number(body.held)).toBe(5);
    expect(Number(body.available)).toBe(95);
    expect(Number(body.balance)).toBe(100);
  });

  it("T4 — unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getCredits(anonymousRequest(BASE));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
