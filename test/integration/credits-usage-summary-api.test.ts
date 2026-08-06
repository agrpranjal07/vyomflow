import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getUsageSummary } from "@/app/api/v1/me/credits/usage-summary/route";
import { reserveHold, reserveAdditional, captureForTool, releaseHold, recordUsage } from "@/services/credits";
import { authedRequest, anonymousRequest } from "../support/request";
import { testDb } from "../support/db";

const BASE = "http://localhost/api/v1/me/credits/usage-summary";

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

describe("GET /api/v1/me/credits/usage-summary", () => {
  it("groups by tool name, excludes RESERVE/RELEASE from totals, and maps display names correctly", async () => {
    const user = await makeUser("user_summary_1", 100);
    const run = await makeChatAndRun(user.id, 1);
    const cropTool = await makeToolInvocation(run.id, "call_crop", "crop_image");

    // Full hold lifecycle for one tool call: RESERVE -> CAPTURE -> RELEASE.
    // Only CAPTURE should count toward totalDebited/records for this tool —
    // RESERVE/RELEASE are hold bookkeeping, not spend, and must not
    // double-count the same 4 credits already captured.
    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 1 }));
    await prisma.$transaction((tx) =>
      reserveAdditional(tx, { runId: run.id, userId: user.id, toolInvocationId: cropTool.id, amount: 4 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: cropTool.id, amount: 4 }),
    );
    await prisma.$transaction((tx) => releaseHold(tx, run.id));

    // Bare LLM usage (no tool) — zero-cost USAGE row, groups under "none"/
    // "VyomFlow".
    await prisma.$transaction((tx) => recordUsage(tx, { runId: run.id, userId: user.id, turnIndex: 0, metadata: {} }));

    const res = await getUsageSummary(authedRequest(BASE, "user_summary_1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const cropGroup = body.groups.find((g: { toolKey: string }) => g.toolKey === "crop_image");
    expect(cropGroup.displayName).toBe("AI Crop Image");
    expect(Number(cropGroup.totalDebited)).toBeCloseTo(4, 6);
    expect(cropGroup.records).toBe(1);

    const llmGroup = body.groups.find((g: { toolKey: string }) => g.toolKey === "none");
    expect(llmGroup.displayName).toBe("VyomFlow");
    expect(Number(llmGroup.totalDebited)).toBeCloseTo(0, 6);
    expect(llmGroup.records).toBe(1);

    // Overall totals must equal CAPTURE(4) + USAGE(0) only — never
    // RESERVE(1+4) or RELEASE(1) folded in, which would double-count.
    expect(Number(body.totalDebitedAll)).toBeCloseTo(4, 6);
    expect(body.recordsAll).toBe(2);
    expect(body.categoriesCount).toBe(2);
    expect(body.periodStart).not.toBeNull();
    expect(body.periodEnd).not.toBeNull();
  });

  it("nets multiple CAPTURE/USAGE rows in the same run+tool into one record (netted-rows fold-in)", async () => {
    // credits.md "`/usage` — Action/'View details' drill-down gap": a
    // single run/turn can write several CAPTURE/USAGE rows for the same
    // tool bucket (e.g. two tool calls in one turn, or a USAGE row plus a
    // CAPTURE). "records" must count distinct runs, not raw ledger rows —
    // otherwise the Overview count would never match the Detailed View's
    // own netted row count.
    const user = await makeUser("user_summary_net", 100);
    const run = await makeChatAndRun(user.id, 1);
    const cropA = await makeToolInvocation(run.id, "call_crop_a", "crop_image");
    const cropB = await makeToolInvocation(run.id, "call_crop_b", "crop_image");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 10 }));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: cropA.id, amount: 3 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: cropB.id, amount: 2 }),
    );

    const res = await getUsageSummary(authedRequest(BASE, "user_summary_net"));
    const body = await res.json();
    const cropGroup = body.groups.find((g: { toolKey: string }) => g.toolKey === "crop_image");
    // Two CAPTURE rows, same run — one netted record, summed amount.
    expect(cropGroup.records).toBe(1);
    expect(Number(cropGroup.totalDebited)).toBeCloseTo(5, 6);
    expect(body.recordsAll).toBe(1);
  });

  it("maps generate_image and merge_videos to their exact display names", async () => {
    const user = await makeUser("user_summary_2", 100);
    const run = await makeChatAndRun(user.id, 1);
    const generateTool = await makeToolInvocation(run.id, "call_generate", "generate_image");
    const mergeTool = await makeToolInvocation(run.id, "call_merge", "merge_videos");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: run.id, userId: user.id, amount: 10 }));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: generateTool.id, amount: 2 }),
    );
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: run.id, userId: user.id, toolInvocationId: mergeTool.id, amount: 3 }),
    );

    const res = await getUsageSummary(authedRequest(BASE, "user_summary_2"));
    const body = await res.json();
    const names = body.groups.map((g: { displayName: string }) => g.displayName).sort();
    expect(names).toEqual(["AI Generate Image", "AI Merge Videos"].sort());
  });

  it("returns null period and zero totals honestly when there is no history yet", async () => {
    const user = await makeUser("user_summary_empty", 100);
    const res = await getUsageSummary(authedRequest(BASE, "user_summary_empty"));
    const body = await res.json();
    expect(body.groups).toEqual([]);
    expect(body.totalDebitedAll).toBe("0.0000");
    expect(body.recordsAll).toBe(0);
    expect(body.categoriesCount).toBe(0);
    expect(body.periodStart).toBeNull();
    expect(body.periodEnd).toBeNull();
  });

  it("per-caller isolation: never aggregates another user's ledger rows", async () => {
    const userA = await makeUser("user_summary_a", 100);
    const userB = await makeUser("user_summary_b", 100);
    const runA = await makeChatAndRun(userA.id, 1);
    const runB = await makeChatAndRun(userB.id, 1);
    const toolA = await makeToolInvocation(runA.id, "call_a", "crop_image");
    const toolB = await makeToolInvocation(runB.id, "call_b", "crop_image");

    await prisma.$transaction((tx) => reserveHold(tx, { runId: runA.id, userId: userA.id, amount: 5 }));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: runA.id, userId: userA.id, toolInvocationId: toolA.id, amount: 5 }),
    );
    await prisma.$transaction((tx) => reserveHold(tx, { runId: runB.id, userId: userB.id, amount: 9 }));
    await prisma.$transaction((tx) =>
      captureForTool(tx, { runId: runB.id, userId: userB.id, toolInvocationId: toolB.id, amount: 9 }),
    );

    const res = await getUsageSummary(authedRequest(BASE, "user_summary_a"));
    const body = await res.json();
    expect(Number(body.totalDebitedAll)).toBeCloseTo(5, 6);
  });

  it("unauthenticated read is rejected with a non-leaking 401", async () => {
    const res = await getUsageSummary(anonymousRequest(BASE));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
