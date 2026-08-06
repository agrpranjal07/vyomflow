import { describe, it, expect, vi, beforeAll, afterEach, afterAll, beforeEach } from "vitest";
vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { TRANSLOADIT_API_BASE_URL, TRANSLOADIT_UPLOAD_TEMPLATE_ID } from "@/lib/config";
import { transloaditStatusHandler } from "../support/msw-transloadit";

import { POST as createChatRoute } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { POST as mintUploadParamsRoute } from "@/app/api/v1/attachments/upload-params/route";
import { POST as completeAttachmentRoute } from "@/app/api/v1/attachments/[attachmentId]/complete/route";
import { DELETE as cancelAttachmentRoute } from "@/app/api/v1/attachments/[attachmentId]/route";
import { GET as listAttachmentsRoute } from "@/app/api/v1/attachments/route";
import { getAllowedAssetUrls } from "@/trigger/turn";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_MONTHLY_UPLOAD_BYTES } from "@/contracts/attachments";

import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetTriggerMocks();
});
afterAll(() => server.close());

beforeEach(() => {
  process.env.TRANSLOADIT_AUTH_KEY = "test_auth_key";
  process.env.TRANSLOADIT_AUTH_SECRET = "test-secret";
});

const CHATS_BASE = "http://localhost/api/v1/chats";
const ATTACHMENTS_BASE = "http://localhost/api/v1/attachments";

async function createChatAs(clerkUserId: string, title = "Chat") {
  const res = await createChatRoute(authedRequest(CHATS_BASE, clerkUserId, { method: "POST", body: JSON.stringify({ title }) }));
  return res.json();
}

async function makeUserAndChat(clerkUserId: string, title = "Chat") {
  const chat = await createChatAs(clerkUserId, title);
  const user = await testDb.user.findUniqueOrThrow({ where: { clerkUserId } });
  return { userId: user.id, chat };
}

function mintUploadParams(clerkUserId: string, body: unknown) {
  return mintUploadParamsRoute(
    authedRequest(`${ATTACHMENTS_BASE}/upload-params`, clerkUserId, { method: "POST", body: JSON.stringify(body) }),
  );
}

function completeReq(clerkUserId: string, attachmentId: string, assemblyId: string) {
  return completeAttachmentRoute(
    authedRequest(`${ATTACHMENTS_BASE}/${attachmentId}/complete`, clerkUserId, {
      method: "POST",
      body: JSON.stringify({ assemblyId }),
    }),
    { params: Promise.resolve({ attachmentId }) },
  );
}

function cancelReq(clerkUserId: string, attachmentId: string) {
  return cancelAttachmentRoute(authedRequest(`${ATTACHMENTS_BASE}/${attachmentId}`, clerkUserId, { method: "DELETE" }), {
    params: Promise.resolve({ attachmentId }),
  });
}

function listReq(clerkUserId: string, query: string) {
  return listAttachmentsRoute(authedRequest(`${ATTACHMENTS_BASE}?${query}`, clerkUserId));
}

function sendReq(chatId: string, clerkUserId: string, body: unknown) {
  return sendMessage(
    authedRequest(`${CHATS_BASE}/${chatId}/messages`, clerkUserId, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ chatId }) },
  );
}

// The Assembly-status fixture must echo back template_id + fields.{attachmentId,
// ownerId} — completeAttachment's identity/byte-validation fix (services/
// attachments.ts) rejects a completed Assembly as ASSEMBLY_MISMATCH unless
// these match the attachment being completed, so every fixture below must
// carry the real attachmentId/ownerId it's completing, not a bare stub.
function mockAssemblyComplete(
  assemblyId: string,
  resultUrl: string,
  identity: { attachmentId: string; ownerId: string },
  opts: { bytesReceived?: number } = {},
) {
  server.use(
    transloaditStatusHandler(`${TRANSLOADIT_API_BASE_URL}/assemblies/${assemblyId}`, {
      ok: "ASSEMBLY_COMPLETED",
      results: { stored: [{ ssl_url: resultUrl }] },
      template_id: TRANSLOADIT_UPLOAD_TEMPLATE_ID,
      fields: { attachmentId: identity.attachmentId, ownerId: identity.ownerId },
      ...(opts.bytesReceived !== undefined ? { bytes_received: opts.bytesReceived } : {}),
    }),
  );
}

/** Mints, then server-verified-completes, one attachment. Leaves it unbound. */
async function uploadAndComplete(
  clerkUserId: string,
  chatId: string,
  opts: { fileName?: string; resultUrl?: string } = {},
) {
  const fileName = opts.fileName ?? "photo.png";
  const resultUrl = opts.resultUrl ?? `https://cdn.example.com/${fileName}`;
  const ownerId = (await testDb.user.findUniqueOrThrow({ where: { clerkUserId } })).id;
  const mintRes = await mintUploadParams(clerkUserId, {
    chatId,
    files: [{ fileName, mimeType: "image/png", byteSize: 1024 }],
  });
  expect(mintRes.status).toBe(201);
  const { uploads } = await mintRes.json();
  const attachmentId = uploads[0].attachmentId as string;
  const assemblyId = `asm_${attachmentId}`;
  mockAssemblyComplete(assemblyId, resultUrl, { attachmentId, ownerId });
  const completeRes = await completeReq(clerkUserId, attachmentId, assemblyId);
  expect(completeRes.status).toBe(200);
  const body = await completeRes.json();
  return { attachmentId, assemblyId, resultUrl, body };
}

/**
 * Seeds one COMPLETED ToolInvocation (the media-library "generated" source
 * — see listAttachments' unbound branch) with the given resultUrls, so its
 * URLs get projected into synthetic AttachmentDTOs at read time. Mirrors
 * the shape used by the getAllowedAssetUrls suite's seedToolInvocation
 * below, but sets status: "COMPLETED" (that helper leaves it DISPATCHING,
 * which the library listing's `status: "COMPLETED"` filter would exclude).
 */
async function seedCompletedToolInvocation(chatId: string, nodeType: string, resultUrls: string[]) {
  const userMessage = await testDb.message.create({
    data: { chatId, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
  });
  // status: "completed" — the schema's partial unique index only allows one
  // non-terminal (queued/running/waiting) run per chat, and these tests
  // create several ToolInvocations against the same chat.
  const run = await testDb.agentRun.create({
    data: {
      chatId,
      idempotencyKey: `send:${chatId}:${userMessage.id}`,
      userMessageId: userMessage.id,
      requestedModel: "openrouter/free",
      status: "completed",
    },
  });
  return testDb.toolInvocation.create({
    data: {
      agentRunId: run.id,
      turnIndex: 0,
      callIndex: 0,
      toolCallId: `call_${run.id}`,
      name: nodeType,
      nodeType,
      input: {},
      status: "COMPLETED",
      resultUrls,
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("requestUploadParams / POST /upload-params", () => {
  it("rejects a batch scoped to a chat owned by another user (non-leaking 404), writing nothing", async () => {
    const owner = await makeUserAndChat("user_up_owner");
    const res = await mintUploadParams("user_up_attacker", {
      chatId: owner.chat.id,
      files: [{ fileName: "a.png", mimeType: "image/png", byteSize: 1024 }],
    });
    expect(res.status).toBe(404);
    expect(await testDb.attachment.count({ where: { chatId: owner.chat.id } })).toBe(0);
  });

  it("rejects a batch exceeding MAX_ATTACHMENTS_PER_MESSAGE, writing nothing", async () => {
    const { userId, chat } = await makeUserAndChat("user_up_toomany");
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({
      fileName: `f${i}.png`,
      mimeType: "image/png",
      byteSize: 1024,
    }));
    const res = await mintUploadParams("user_up_toomany", { chatId: chat.id, files });
    expect(res.status).toBe(400);
    expect(await testDb.attachment.count({ where: { ownerId: userId } })).toBe(0);
  });

  it("rejects a single oversized file, writing nothing", async () => {
    const { userId, chat } = await makeUserAndChat("user_up_oversized");
    const res = await mintUploadParams("user_up_oversized", {
      chatId: chat.id,
      files: [{ fileName: "huge.mp4", mimeType: "video/mp4", byteSize: MAX_ATTACHMENT_BYTES + 1 }],
    });
    expect(res.status).toBe(400);
    expect(await testDb.attachment.count({ where: { ownerId: userId } })).toBe(0);
  });

  it("rejects a batch that would exceed the monthly upload quota, writing nothing new", async () => {
    const { userId, chat } = await makeUserAndChat("user_up_quota");
    // Seed prior READY usage this month close to the cap — spread across
    // several rows since a single column value is Int32-bounded (well under
    // the 5GB monthly cap itself), same as a real month of several uploads.
    // ~161MB of headroom remains below MAX_MONTHLY_UPLOAD_BYTES (5GB).
    const seedSizes = [2_000_000_000, 2_000_000_000, 1_200_000_000];
    for (const [i, byteSize] of seedSizes.entries()) {
      await testDb.attachment.create({
        data: { chatId: chat.id, ownerId: userId, orderIndex: i, status: "READY", byteSize, mimeType: "video/mp4", fileName: `prior${i}.mp4` },
      });
    }
    expect(seedSizes.reduce((a, b) => a + b, 0)).toBeLessThan(MAX_MONTHLY_UPLOAD_BYTES);

    // 200MB is within the per-file cap but tips the running total over 5GB.
    const res = await mintUploadParams("user_up_quota", {
      chatId: chat.id,
      files: [{ fileName: "more.png", mimeType: "image/png", byteSize: 200_000_000 }],
    });
    expect(res.status).toBe(400);
    // Still exactly the seeded rows — nothing new persisted.
    expect(await testDb.attachment.count({ where: { ownerId: userId } })).toBe(seedSizes.length);
  });

  // Bug fix (B): the quota check + create must run inside one Serializable
  // transaction — two concurrent batches that each individually fit under
  // the monthly cap, but together exceed it, must not both commit (a
  // read-then-write race would let both pass on a stale snapshot).
  it("under concurrent batches that together exceed the monthly quota, exactly one commits (Serializable isolation)", async () => {
    const { userId, chat } = await makeUserAndChat("user_up_race");
    // ~268MB of headroom below the 5GB (5,368,709,120-byte) cap — enough for
    // either 200MB batch alone, not both together. byteSize is Int32-bounded,
    // so this is spread across several rows (same pattern as the sequential
    // quota test above), not one column value.
    const seedSizes = [2_000_000_000, 2_000_000_000, 1_100_000_000];
    for (const [i, byteSize] of seedSizes.entries()) {
      await testDb.attachment.create({
        data: { chatId: chat.id, ownerId: userId, orderIndex: i, status: "READY", byteSize, mimeType: "video/mp4", fileName: `prior${i}.mp4` },
      });
    }

    // Each individual batch (200MB) fits in the ~320MB headroom, but both
    // together (400MB) do not.
    const fileBody = (name: string) => ({
      chatId: chat.id,
      files: [{ fileName: name, mimeType: "image/png", byteSize: 200_000_000 }],
    });
    const [resA, resB] = await Promise.all([
      mintUploadParams("user_up_race", fileBody("race-a.png")),
      mintUploadParams("user_up_race", fileBody("race-b.png")),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // One must succeed (201) and the other must be rejected (400) — never
    // both succeeding (which would blow the quota) and never both failing
    // (a false rejection of a batch that actually fit on its own).
    expect(statuses).toEqual([201, 400]);

    const newRows = await testDb.attachment.count({ where: { ownerId: userId, status: "PENDING" } });
    expect(newRows).toBe(1);
  });

  it("mints signed params and creates one PENDING row per file on a valid batch", async () => {
    const { userId, chat } = await makeUserAndChat("user_up_ok");
    const res = await mintUploadParams("user_up_ok", {
      chatId: chat.id,
      files: [
        { fileName: "a.png", mimeType: "image/png", byteSize: 1024 },
        { fileName: "b.png", mimeType: "image/png", byteSize: 2048 },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.uploads).toHaveLength(2);
    expect(body.uploads[0].params).toBeTruthy();
    expect(body.uploads[0].signature).toBeTruthy();

    const rows = await testDb.attachment.findMany({ where: { ownerId: userId }, orderBy: { orderIndex: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
    expect(rows.map((r) => r.orderIndex)).toEqual([0, 1]);
  });
});

describe("completeAttachment / POST /:id/complete", () => {
  it("persists READY with the server-verified resultUrl on a successful Assembly", async () => {
    const { chat } = await makeUserAndChat("user_complete_ok");
    const { attachmentId, resultUrl, body } = await uploadAndComplete("user_complete_ok", chat.id);
    expect(body.status).toBe("READY");
    expect(body.resultUrl).toBe(resultUrl);

    const row = await testDb.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.status).toBe("READY");
    expect(row.resultUrl).toBe(resultUrl);
  });

  it("persists FAILED with a generic, user-safe errorMessage when the Assembly did not complete", async () => {
    const { userId, chat } = await makeUserAndChat("user_complete_fail");
    const mintRes = await mintUploadParams("user_complete_fail", {
      chatId: chat.id,
      files: [{ fileName: "bad.png", mimeType: "image/png", byteSize: 1024 }],
    });
    const { uploads } = await mintRes.json();
    const attachmentId = uploads[0].attachmentId as string;
    const assemblyId = `asm_${attachmentId}`;
    server.use(
      transloaditStatusHandler(`${TRANSLOADIT_API_BASE_URL}/assemblies/${assemblyId}`, {
        ok: "ASSEMBLY_FAILED",
        error: "SOME_RAW_TRANSLOADIT_INTERNAL_DETAIL_never_leak_this",
      }),
    );

    const res = await completeReq("user_complete_fail", attachmentId, assemblyId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("FAILED");
    expect(body.errorMessage).toBe("Upload could not be processed. Please try again.");
    expect(body.errorMessage).not.toContain("SOME_RAW_TRANSLOADIT_INTERNAL_DETAIL_never_leak_this");

    const row = await testDb.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.status).toBe("FAILED");
    expect(row.ownerId).toBe(userId);
  });

  it("is idempotent against a duplicate completion call — the second call is a no-op, no second Transloadit fetch", async () => {
    const { userId, chat } = await makeUserAndChat("user_complete_idem");
    const mintRes = await mintUploadParams("user_complete_idem", {
      chatId: chat.id,
      files: [{ fileName: "once.png", mimeType: "image/png", byteSize: 1024 }],
    });
    const { uploads } = await mintRes.json();
    const attachmentId = uploads[0].attachmentId as string;
    const assemblyId = `asm_${attachmentId}`;

    let statusCallCount = 0;
    server.use(
      http.get(`${TRANSLOADIT_API_BASE_URL}/assemblies/${assemblyId}`, () => {
        statusCallCount += 1;
        return HttpResponse.json({
          ok: "ASSEMBLY_COMPLETED",
          results: { stored: [{ ssl_url: "https://cdn.example.com/once.png" }] },
          template_id: TRANSLOADIT_UPLOAD_TEMPLATE_ID,
          fields: { attachmentId, ownerId: userId },
        });
      }),
    );

    const first = await completeReq("user_complete_idem", attachmentId, assemblyId);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(statusCallCount).toBe(1);

    const second = await completeReq("user_complete_idem", attachmentId, assemblyId);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    expect(statusCallCount).toBe(1); // no second Transloadit fetch
  });

  it("returns a non-leaking 404 for another user's attachment id", async () => {
    const { chat } = await makeUserAndChat("user_complete_owner");
    const mintRes = await mintUploadParams("user_complete_owner", {
      chatId: chat.id,
      files: [{ fileName: "mine.png", mimeType: "image/png", byteSize: 1024 }],
    });
    const { uploads } = await mintRes.json();
    const attachmentId = uploads[0].attachmentId as string;

    const res = await completeReq("user_complete_attacker", attachmentId, "asm_whatever");
    expect(res.status).toBe(404);
  });
});

describe("cancelAttachment / DELETE /:id", () => {
  it("cancels a still-PENDING unbound row", async () => {
    const { chat } = await makeUserAndChat("user_cancel_pending");
    const mintRes = await mintUploadParams("user_cancel_pending", {
      chatId: chat.id,
      files: [{ fileName: "cancel-me.png", mimeType: "image/png", byteSize: 1024 }],
    });
    const { uploads } = await mintRes.json();
    const attachmentId = uploads[0].attachmentId as string;

    const res = await cancelReq("user_cancel_pending", attachmentId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("CANCELLED");

    const row = await testDb.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.status).toBe("CANCELLED");
  });

  // A READY-but-unbound row is the media-library "delete" action, not a
  // cancel — DELETE /:id falls through cancelAttachment (PENDING-only) to
  // deleteAttachment for this case (see the route's `cancelled ?? deleteAttachment(...)`),
  // hard-deleting the row. Only an already-BOUND row must stay protected
  // (404, sibling test below) — that's the actually security-relevant case.
  it("hard-deletes an already-READY (completed, unbound) row via the media-library delete path", async () => {
    const { chat } = await makeUserAndChat("user_cancel_ready");
    const { attachmentId } = await uploadAndComplete("user_cancel_ready", chat.id);

    const res = await cancelReq("user_cancel_ready", attachmentId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("READY");

    const row = await testDb.attachment.findUnique({ where: { id: attachmentId } });
    expect(row).toBeNull();
  });

  it("404s on an already-bound row", async () => {
    const clerkUserId = "user_cancel_bound";
    const { chat } = await makeUserAndChat(clerkUserId);
    const { attachmentId } = await uploadAndComplete(clerkUserId, chat.id);

    const sendRes = await sendReq(chat.id, clerkUserId, { content: [], attachments: [{ id: attachmentId }] });
    expect(sendRes.status).toBe(201);

    const res = await cancelReq(clerkUserId, attachmentId);
    expect(res.status).toBe(404);

    const row = await testDb.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.messageId).not.toBeNull();
  });
});

describe("listAttachments / GET /attachments", () => {
  it("unbound=true returns only the caller's unbound READY rows, newest-first, paginated across a page boundary", async () => {
    const clerkUserId = "user_list_unbound";
    const { chat } = await makeUserAndChat(clerkUserId);

    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { attachmentId } = await uploadAndComplete(clerkUserId, chat.id, { fileName: `u${i}.png` });
      created.push(attachmentId);
      await new Promise((r) => setTimeout(r, 2)); // strictly increasing createdAt
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url = new URLSearchParams({ unbound: "true", limit: "2" });
      if (cursor) url.set("cursor", cursor);
      const res = await listReq(clerkUserId, url.toString());
      expect(res.status).toBe(200);
      const body = await res.json();
      seen.push(...body.items.map((a: { id: string }) => a.id));
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(created));
    // Newest-first: the last-created attachment is first in the full listing.
    expect(seen[0]).toBe(created[created.length - 1]);
  });

  it("chatId= scopes to that chat's rows regardless of status", async () => {
    const clerkUserId = "user_list_scope";
    const { chat: chatA } = await makeUserAndChat(clerkUserId, "Chat A");
    const chatB = await createChatAs(clerkUserId, "Chat B");

    const { attachmentId: readyInA } = await uploadAndComplete(clerkUserId, chatA.id, { fileName: "a-ready.png" });
    const pendingMint = await mintUploadParams(clerkUserId, {
      chatId: chatA.id,
      files: [{ fileName: "a-pending.png", mimeType: "image/png", byteSize: 512 }],
    });
    const { uploads: pendingUploads } = await pendingMint.json();
    const pendingInA = pendingUploads[0].attachmentId as string;
    await uploadAndComplete(clerkUserId, chatB.id, { fileName: "b-ready.png" });

    const res = await listReq(clerkUserId, `chatId=${chatA.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((a: { id: string }) => a.id);
    expect(new Set(ids)).toEqual(new Set([readyInA, pendingInA]));
  });

  it("never returns another user's rows", async () => {
    const { chat } = await makeUserAndChat("user_list_owner");
    await uploadAndComplete("user_list_owner", chat.id, { fileName: "private.png" });

    const res = await listReq("user_list_attacker", "unbound=true");
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("paginates a mix of real uploads and multi-url generated results with no duplicates/gaps, never splitting a generated group across pages", async () => {
    const clerkUserId = "user_list_mixed";
    const { chat } = await makeUserAndChat(clerkUserId);

    const expectedIds: string[] = [];

    const u0 = await uploadAndComplete(clerkUserId, chat.id, { fileName: "u0.png" });
    expectedIds.push(u0.attachmentId);
    await sleep(3);

    // generate_image can produce up to n=4 images from one invocation — this
    // one lands 3 URLs mid-sequence, right where a page boundary should fall.
    const gen0 = await seedCompletedToolInvocation(chat.id, "generate_image", [
      "https://gen.example.com/gen0-0.png",
      "https://gen.example.com/gen0-1.png",
      "https://gen.example.com/gen0-2.png",
    ]);
    expectedIds.push(`${gen0.id}:0`, `${gen0.id}:1`, `${gen0.id}:2`);
    await sleep(3);

    const u1 = await uploadAndComplete(clerkUserId, chat.id, { fileName: "u1.png" });
    expectedIds.push(u1.attachmentId);
    await sleep(3);

    const crop0 = await seedCompletedToolInvocation(chat.id, "crop_image", ["https://gen.example.com/crop0-0.png"]);
    expectedIds.push(`${crop0.id}:0`);
    await sleep(3);

    const u2 = await uploadAndComplete(clerkUserId, chat.id, { fileName: "u2.png" });
    expectedIds.push(u2.attachmentId);

    const pages: string[][] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url = new URLSearchParams({ unbound: "true", limit: "3" });
      if (cursor) url.set("cursor", cursor);
      const res = await listReq(clerkUserId, url.toString());
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.items.map((a: { id: string }) => a.id);
      pages.push(ids);
      seen.push(...ids);
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(seen).toHaveLength(expectedIds.length);
    expect(new Set(seen)).toEqual(new Set(expectedIds));
    // No duplicates.
    expect(new Set(seen).size).toBe(seen.length);

    // gen0's 3-item group must never be split across two pages.
    const gen0Ids = [`${gen0.id}:0`, `${gen0.id}:1`, `${gen0.id}:2`];
    const pageWithGen0 = pages.find((p) => p.some((id) => gen0Ids.includes(id)));
    expect(pageWithGen0).toBeDefined();
    expect(gen0Ids.every((id) => pageWithGen0!.includes(id))).toBe(true);
  });

  it("keeps a 4-url generate_image group intact even when it straddles the page boundary", async () => {
    const clerkUserId = "user_list_boundary";
    const { chat } = await makeUserAndChat(clerkUserId);

    // Oldest -> newest: gA(1 url), gB(4 urls), gC(1 url), gD(2 urls).
    // With limit=2, the accumulation naturally stops mid-way through gB
    // once it's fetched, forcing gB's whole group onto one page.
    const gA = await seedCompletedToolInvocation(chat.id, "crop_image", ["https://gen.example.com/gA-0.png"]);
    await sleep(3);
    const gB = await seedCompletedToolInvocation(chat.id, "generate_image", [
      "https://gen.example.com/gB-0.png",
      "https://gen.example.com/gB-1.png",
      "https://gen.example.com/gB-2.png",
      "https://gen.example.com/gB-3.png",
    ]);
    await sleep(3);
    const gC = await seedCompletedToolInvocation(chat.id, "crop_image", ["https://gen.example.com/gC-0.png"]);
    await sleep(3);
    const gD = await seedCompletedToolInvocation(chat.id, "merge_videos", [
      "https://gen.example.com/gD-0.png",
      "https://gen.example.com/gD-1.png",
    ]);

    const expectedIds = [
      `${gA.id}:0`,
      `${gB.id}:0`,
      `${gB.id}:1`,
      `${gB.id}:2`,
      `${gB.id}:3`,
      `${gC.id}:0`,
      `${gD.id}:0`,
      `${gD.id}:1`,
    ];

    const pages: string[][] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url = new URLSearchParams({ unbound: "true", source: "generated", limit: "2" });
      if (cursor) url.set("cursor", cursor);
      const res = await listReq(clerkUserId, url.toString());
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.items.map((a: { id: string }) => a.id);
      pages.push(ids);
      seen.push(...ids);
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(seen).toHaveLength(expectedIds.length);
    expect(new Set(seen)).toEqual(new Set(expectedIds));
    expect(new Set(seen).size).toBe(seen.length);

    const gBIds = [`${gB.id}:0`, `${gB.id}:1`, `${gB.id}:2`, `${gB.id}:3`];
    const pageWithGB = pages.find((p) => p.some((id) => gBIds.includes(id)));
    expect(pageWithGB).toBeDefined();
    expect(gBIds.every((id) => pageWithGB!.includes(id))).toBe(true);
  });

  it("source=generated and source=uploaded each paginate only their own stream, complete and non-duplicated", async () => {
    const clerkUserId = "user_list_source_filter";
    const { chat } = await makeUserAndChat(clerkUserId);

    const uploadedIds: string[] = [];
    const generatedIds: string[] = [];

    for (let i = 0; i < 4; i++) {
      const u = await uploadAndComplete(clerkUserId, chat.id, { fileName: `su${i}.png` });
      uploadedIds.push(u.attachmentId);
      await sleep(3);
      const g = await seedCompletedToolInvocation(chat.id, "crop_image", [`https://gen.example.com/sg${i}-0.png`]);
      generatedIds.push(`${g.id}:0`);
      await sleep(3);
    }

    async function walk(source: "uploaded" | "generated") {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const url = new URLSearchParams({ unbound: "true", source, limit: "2" });
        if (cursor) url.set("cursor", cursor);
        const res = await listReq(clerkUserId, url.toString());
        expect(res.status).toBe(200);
        const body = await res.json();
        for (const item of body.items as { id: string; source: string }[]) {
          expect(item.source).toBe(source);
        }
        seen.push(...body.items.map((a: { id: string }) => a.id));
        cursor = body.nextCursor;
        guard += 1;
      } while (cursor && guard < 20);
      return seen;
    }

    const seenUploaded = await walk("uploaded");
    expect(seenUploaded).toHaveLength(uploadedIds.length);
    expect(new Set(seenUploaded)).toEqual(new Set(uploadedIds));
    expect(new Set(seenUploaded).size).toBe(seenUploaded.length);

    const seenGenerated = await walk("generated");
    expect(seenGenerated).toHaveLength(generatedIds.length);
    expect(new Set(seenGenerated)).toEqual(new Set(generatedIds));
    expect(new Set(seenGenerated).size).toBe(seenGenerated.length);
  });
});

describe("bindAttachmentsToMessage — via the send-turn flow", () => {
  it("preserves the client-requested order via orderIndex, not creation order", async () => {
    const clerkUserId = "user_bind_order";
    const { chat } = await makeUserAndChat(clerkUserId);

    const first = await uploadAndComplete(clerkUserId, chat.id, { fileName: "first.png" });
    const second = await uploadAndComplete(clerkUserId, chat.id, { fileName: "second.png" });
    const third = await uploadAndComplete(clerkUserId, chat.id, { fileName: "third.png" });

    // Send in a scrambled order, deliberately not creation order.
    const requestedOrder = [third.attachmentId, first.attachmentId, second.attachmentId];
    const res = await sendReq(chat.id, clerkUserId, {
      content: [],
      attachments: requestedOrder.map((id) => ({ id })),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.attachments.map((a: { id: string }) => a.id)).toEqual(requestedOrder);
    expect(body.message.attachments.map((a: { orderIndex: number }) => a.orderIndex)).toEqual([0, 1, 2]);
  });

  it("rejects (400) binding a foreign chat's attachment — never silently drops it", async () => {
    const clerkUserId = "user_bind_foreign";
    const { chat: chatA } = await makeUserAndChat(clerkUserId, "Chat A");
    const chatB = await createChatAs(clerkUserId, "Chat B");
    const { attachmentId } = await uploadAndComplete(clerkUserId, chatA.id, { fileName: "from-a.png" });

    const res = await sendReq(chatB.id, clerkUserId, { content: [], attachments: [{ id: attachmentId }] });
    expect(res.status).toBe(400);

    const messagesInB = await testDb.message.count({ where: { chatId: chatB.id } });
    expect(messagesInB).toBe(0);
  });

  it("rejects (400) binding an already-bound attachment", async () => {
    const clerkUserId = "user_bind_already";
    const { chat } = await makeUserAndChat(clerkUserId);
    const { attachmentId } = await uploadAndComplete(clerkUserId, chat.id);

    const firstSend = await sendReq(chat.id, clerkUserId, { content: [], attachments: [{ id: attachmentId }] });
    expect(firstSend.status).toBe(201);
    await testDb.agentRun.updateMany({ where: { chatId: chat.id }, data: { status: "completed" } });

    const secondSend = await sendReq(chat.id, clerkUserId, {
      content: [{ type: "text", text: "reuse attempt" }],
      attachments: [{ id: attachmentId }],
    });
    expect(secondSend.status).toBe(400);
  });

  it("rejects (400) binding a non-READY (still PENDING) attachment", async () => {
    const clerkUserId = "user_bind_pending";
    const { chat } = await makeUserAndChat(clerkUserId);
    const mintRes = await mintUploadParams(clerkUserId, {
      chatId: chat.id,
      files: [{ fileName: "not-ready.png", mimeType: "image/png", byteSize: 1024 }],
    });
    const { uploads } = await mintRes.json();
    const attachmentId = uploads[0].attachmentId as string;

    const res = await sendReq(chat.id, clerkUserId, { content: [], attachments: [{ id: attachmentId }] });
    expect(res.status).toBe(400);
  });
});

describe("repeated-transition coverage — two full upload -> complete -> bind cycles in the same chat", () => {
  it("nothing leaks between message A's send and message B's send", async () => {
    const clerkUserId = "user_cycle";
    const { chat } = await makeUserAndChat(clerkUserId);

    // Cycle 1 -> message A.
    const a1 = await uploadAndComplete(clerkUserId, chat.id, { fileName: "a1.png" });
    const sendA = await sendReq(chat.id, clerkUserId, { content: [], attachments: [{ id: a1.attachmentId }] });
    expect(sendA.status).toBe(201);
    const bodyA = await sendA.json();
    expect(bodyA.message.attachments.map((a: { id: string }) => a.id)).toEqual([a1.attachmentId]);
    expect(bodyA.message.attachments[0].orderIndex).toBe(0);
    await testDb.agentRun.updateMany({ where: { chatId: chat.id }, data: { status: "completed" } });

    // Cycle 2 -> message B, a brand-new upload.
    const b1 = await uploadAndComplete(clerkUserId, chat.id, { fileName: "b1.png" });
    const sendB = await sendReq(chat.id, clerkUserId, { content: [], attachments: [{ id: b1.attachmentId }] });
    expect(sendB.status).toBe(201);
    const bodyB = await sendB.json();

    // No leak from cycle 1: message B carries only its own attachment.
    expect(bodyB.message.attachments.map((a: { id: string }) => a.id)).toEqual([b1.attachmentId]);
    // orderIndex is scoped to this bind call, not a running chat-wide counter.
    expect(bodyB.message.attachments[0].orderIndex).toBe(0);

    // Message A is unaffected by message B's send.
    const messageARow = await testDb.message.findUniqueOrThrow({ where: { id: bodyA.message.id } });
    const attachmentsOfA = await testDb.attachment.findMany({ where: { messageId: messageARow.id } });
    expect(attachmentsOfA.map((att) => att.id)).toEqual([a1.attachmentId]);

    const attachmentA1Row = await testDb.attachment.findUniqueOrThrow({ where: { id: a1.attachmentId } });
    expect(attachmentA1Row.messageId).toBe(bodyA.message.id);
  });
});

describe("getAllowedAssetUrls — tool-dispatch URL allowlist", () => {
  async function seedToolInvocation(chatId: string, resultUrls: string[], sourceUrls: string[]) {
    const userMessage = await testDb.message.create({
      data: { chatId, role: "user", status: "complete", content: [{ type: "text", text: "hi" }] },
    });
    const run = await testDb.agentRun.create({
      data: { chatId, idempotencyKey: `send:${chatId}:${userMessage.id}`, userMessageId: userMessage.id, requestedModel: "openrouter/free" },
    });
    await testDb.toolInvocation.create({
      data: {
        agentRunId: run.id,
        turnIndex: 0,
        callIndex: 0,
        toolCallId: "call_1",
        name: "crop_image",
        nodeType: "crop_image",
        input: {},
        resultUrls,
        sourceUrls,
      },
    });
  }

  it("returns exactly this chat's owned READY attachment URLs + prior tool invocation URLs, excluding another chat's", async () => {
    const clerkUserId = "user_allowlist";
    const { userId, chat: chatA } = await makeUserAndChat(clerkUserId, "Chat A");
    const chatB = await createChatAs(clerkUserId, "Chat B");

    await testDb.attachment.create({
      data: { chatId: chatA.id, ownerId: userId, orderIndex: 0, status: "READY", resultUrl: "https://cdn.example.com/mine.png" },
    });
    await seedToolInvocation(chatA.id, ["https://gen.example.com/out.png"], ["https://source.example.com/in.png"]);

    // Another chat's own attachment must never leak into chat A's set.
    await testDb.attachment.create({
      data: { chatId: chatB.id, ownerId: userId, orderIndex: 0, status: "READY", resultUrl: "https://cdn.example.com/other.png" },
    });

    const allowed = await getAllowedAssetUrls(chatA.id);
    expect(allowed).toEqual(
      new Set(["https://cdn.example.com/mine.png", "https://gen.example.com/out.png", "https://source.example.com/in.png"]),
    );
  });
});
