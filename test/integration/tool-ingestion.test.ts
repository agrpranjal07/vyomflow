import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock only the `execute` seam of crop_image — everything else stays real.
// (see integration/tool-execution.test.ts for the same pattern, reused here
// since this file's own focus is the ingestion/upload branch inside
// executeMediaTool, not the adapter's own logic.)
const { cropExecute } = vi.hoisted(() => ({ cropExecute: vi.fn() }));
vi.mock("@/server/tools/adapters/crop-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tools/adapters/crop-image")>();
  return { ...actual, cropImageTool: { ...actual.cropImageTool, execute: cropExecute } };
});

const { ingestGeneratedAssets, uploadGeneratedArtifacts } = vi.hoisted(() => ({
  ingestGeneratedAssets: vi.fn(),
  uploadGeneratedArtifacts: vi.fn(),
}));
vi.mock("@/server/transloadit/ingest", () => ({ ingestGeneratedAssets }));
vi.mock("@/server/transloadit/upload", () => ({ uploadGeneratedArtifacts }));

import { executeMediaTool } from "@/trigger/tool";
import { testDb } from "../support/db";

async function makeChatRunAndInvocation(name: string, input: Record<string, unknown> = {}) {
  const user = await testDb.user.create({ data: { clerkUserId: `user_${Math.random()}` } });
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
  const invocation = await testDb.toolInvocation.create({
    data: { agentRunId: run.id, turnIndex: 0, callIndex: 0, toolCallId: "call_1", name, nodeType: name, input, creditEstimate: 0.1 },
  });
  return { user, chat, run, invocation };
}

const NO_SIGNAL = { signal: new AbortController().signal };

beforeEach(() => {
  cropExecute.mockReset();
  ingestGeneratedAssets.mockReset();
  uploadGeneratedArtifacts.mockReset();
});

describe("media tool completion — Transloadit ingestion/upload", () => {
  it("ingests a `url` artifact via ingestGeneratedAssets (existing passthrough path, unchanged)", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({ artifacts: [{ kind: "url", url: "https://engine.example.com/cropped.png" }] });
    ingestGeneratedAssets.mockResolvedValueOnce({
      resultUrls: ["https://cdn.example.com/generated/cropped.png"],
      sourceUrls: ["https://engine.example.com/cropped.png"],
      ingestStatus: "INGESTED",
      assemblyId: "asm_1",
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(result.status).toBe("COMPLETED");
    expect(result.resultUrls).toEqual(["https://cdn.example.com/generated/cropped.png"]);

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.resultUrls).toEqual(["https://cdn.example.com/generated/cropped.png"]);
    expect(row.sourceUrls).toEqual(["https://engine.example.com/cropped.png"]);
    expect(row.assetIngestStatus).toBe("INGESTED");
  });

  it("falls back to the raw URL and stays COMPLETED (not FAILED) when a `url` artifact's ingestion fails", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({ artifacts: [{ kind: "url", url: "https://engine.example.com/cropped2.png" }] });
    // ingestGeneratedAssets never throws — falls back to the raw source
    // URLs on any Transloadit failure, unchanged existing behavior.
    ingestGeneratedAssets.mockResolvedValueOnce({
      resultUrls: ["https://engine.example.com/cropped2.png"],
      sourceUrls: ["https://engine.example.com/cropped2.png"],
      ingestStatus: "FAILED",
      assemblyId: null,
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(result.status).toBe("COMPLETED");
    expect(result.resultUrls).toEqual(["https://engine.example.com/cropped2.png"]);

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.resultUrls).toEqual(["https://engine.example.com/cropped2.png"]);
    expect(row.sourceUrls).toEqual(["https://engine.example.com/cropped2.png"]);
    expect(row.assetIngestStatus).toBe("FAILED");
  });

  it("never re-triggers ingestion on a replayed/retried task re-entered on an already-terminal row", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({ artifacts: [{ kind: "url", url: "https://engine.example.com/cropped3.png" }] });
    ingestGeneratedAssets.mockResolvedValueOnce({
      resultUrls: ["https://cdn.example.com/generated/cropped3.png"],
      sourceUrls: ["https://engine.example.com/cropped3.png"],
      ingestStatus: "INGESTED",
      assemblyId: "asm_3",
    });

    const first = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(first.status).toBe("COMPLETED");
    expect(ingestGeneratedAssets).toHaveBeenCalledTimes(1);

    // Re-entry (Trigger.dev retry / duplicate triggerAndWait) on the now-
    // terminal row must short-circuit before reaching the adapter or
    // Transloadit again.
    const second = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(second.status).toBe("COMPLETED");
    expect(cropExecute).toHaveBeenCalledTimes(1);
    expect(ingestGeneratedAssets).toHaveBeenCalledTimes(1);
  });

  // New buffer-upload path (VyomFlow Task 3.1) — a locally-produced
  // `bytes`/`file` artifact has no source URL to ingest via
  // ingestGeneratedAssets, so it goes through uploadGeneratedArtifacts
  // instead. Mocked here rather than exercised against the real live
  // Transloadit template — see integration/tool-execution.test.ts, which
  // already covers this same branch; kept here too since this file's own
  // focus is specifically the ingestion/upload branch selection.
  it("uploads a `bytes` artifact via uploadGeneratedArtifacts, never calling ingestGeneratedAssets", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({
      artifacts: [{ kind: "bytes", body: new Uint8Array([9, 9, 9]), contentType: "image/png", filename: "out.png" }],
    });
    uploadGeneratedArtifacts.mockResolvedValueOnce({
      resultUrls: ["https://cdn.example.com/generated/uploaded.png"],
      sourceUrls: [],
      ingestStatus: "INGESTED",
      assemblyId: "asm_4",
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(result.status).toBe("COMPLETED");
    expect(result.resultUrls).toEqual(["https://cdn.example.com/generated/uploaded.png"]);
    expect(uploadGeneratedArtifacts).toHaveBeenCalledTimes(1);
    expect(ingestGeneratedAssets).not.toHaveBeenCalled();

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.assetIngestStatus).toBe("INGESTED");
  });

  // Genuine, intentional reliability difference from a remote-dispatch model
  // (documented in src/trigger/tool.ts's own comment): unlike the
  // `url` passthrough path above, there is no raw-URL fallback for
  // locally-produced bytes — ctx.workDir is deleted before the invocation
  // could retry, so a failed upload must settle the invocation FAILED, not
  // silently stay COMPLETED with a lost result.
  it("settles FAILED with errorCode asset_upload_failed when uploadGeneratedArtifacts fails for a `bytes` artifact (inverts the url-passthrough fallback behavior)", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({
      artifacts: [{ kind: "bytes", body: new Uint8Array([9, 9, 9]), contentType: "image/png", filename: "out.png" }],
    });
    uploadGeneratedArtifacts.mockRejectedValueOnce(new Error("Transloadit 500"));

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("asset_upload_failed");
    expect(result.resultUrls).toEqual([]);
    // 00-master-spec.md §11: capture nothing on any failure path.
    expect(result.creditUsedApp).toBe(0);

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("asset_upload_failed");
    expect(row.resultUrls).toBeNull();
    expect(row.creditUsed).toBeNull();
  });
});
