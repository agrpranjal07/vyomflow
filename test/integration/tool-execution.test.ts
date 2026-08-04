import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock only the `execute` seam of each adapter — everything else (name,
// inputSchema, engine, estimateCredits) stays real, so executeMediaTool's
// own registry lookup / dispatch logic runs unmocked.
const { cropExecute, generateExecute, mergeExecute } = vi.hoisted(() => ({
  cropExecute: vi.fn(),
  generateExecute: vi.fn(),
  mergeExecute: vi.fn(),
}));
vi.mock("@/server/tools/adapters/crop-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tools/adapters/crop-image")>();
  return { ...actual, cropImageTool: { ...actual.cropImageTool, execute: cropExecute } };
});
vi.mock("@/server/tools/adapters/generate-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tools/adapters/generate-image")>();
  return { ...actual, generateImageTool: { ...actual.generateImageTool, execute: generateExecute } };
});
vi.mock("@/server/tools/adapters/merge-videos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tools/adapters/merge-videos")>();
  return { ...actual, mergeVideosTool: { ...actual.mergeVideosTool, execute: mergeExecute } };
});

const { ingestGeneratedAssets, uploadGeneratedArtifacts } = vi.hoisted(() => ({
  ingestGeneratedAssets: vi.fn(),
  uploadGeneratedArtifacts: vi.fn(),
}));
vi.mock("@/server/transloadit/ingest", () => ({ ingestGeneratedAssets }));
vi.mock("@/server/transloadit/upload", () => ({ uploadGeneratedArtifacts }));

import { existsSync } from "node:fs";
import { executeMediaTool } from "@/trigger/tool";
import { testDb } from "../support/db";
import { CropExtractError } from "@/server/tools/adapters/crop-image";

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
  generateExecute.mockReset();
  mergeExecute.mockReset();
  ingestGeneratedAssets.mockReset();
  uploadGeneratedArtifacts.mockReset();
});

describe("executeMediaTool", () => {
  it("runs the adapter in-process, ingests a `url` artifact via Transloadit, and persists resultUrls/creditUsed", async () => {
    const { invocation } = await makeChatRunAndInvocation("merge_videos", { video_urls: ["https://a.mp4", "https://b.mp4"] });
    mergeExecute.mockResolvedValueOnce({ artifacts: [{ kind: "url", url: "https://out.example.com/merged.mp4" }] });
    ingestGeneratedAssets.mockResolvedValueOnce({
      resultUrls: ["https://ingested.example.com/merged.mp4"],
      sourceUrls: ["https://out.example.com/merged.mp4"],
      ingestStatus: "INGESTED",
      assemblyId: "asm_1",
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("COMPLETED");
    expect(result.resultUrls).toEqual(["https://ingested.example.com/merged.mp4"]);
    // No adapter reports its own creditUsedApp today — settlement falls
    // back to the row's fixed pre-dispatch estimate (0.1).
    expect(result.creditUsedApp).toBeCloseTo(0.1, 6);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mergeExecute).toHaveBeenCalledTimes(1);

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(Number(row.creditUsed)).toBeCloseTo(0.1, 6);
    expect(row.resultUrls).toEqual(["https://ingested.example.com/merged.mp4"]);
    expect(row.finishedAt).not.toBeNull();
  });

  it("uploads a locally-produced `bytes` artifact via uploadGeneratedArtifacts and settles COMPLETED", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({
      artifacts: [{ kind: "bytes", body: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "out.png" }],
    });
    uploadGeneratedArtifacts.mockResolvedValueOnce({
      resultUrls: ["https://uploaded.example.com/out.png"],
      sourceUrls: [],
      ingestStatus: "INGESTED",
      assemblyId: "asm_2",
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("COMPLETED");
    expect(result.resultUrls).toEqual(["https://uploaded.example.com/out.png"]);
    expect(uploadGeneratedArtifacts).toHaveBeenCalledTimes(1);
    expect(ingestGeneratedAssets).not.toHaveBeenCalled();

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.resultUrls).toEqual(["https://uploaded.example.com/out.png"]);
  });

  it("settles FAILED with errorCode asset_upload_failed when uploadGeneratedArtifacts throws (no raw-URL fallback for local bytes)", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockResolvedValueOnce({
      artifacts: [{ kind: "bytes", body: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "out.png" }],
    });
    uploadGeneratedArtifacts.mockRejectedValueOnce(new Error("Transloadit 500"));

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("asset_upload_failed");
    expect(result.resultUrls).toEqual([]);
    // 00-master-spec.md §11: capture nothing on any failure path — an
    // upload failure must not bill the tool's pre-dispatch estimate.
    expect(result.creditUsedApp).toBe(0);

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("asset_upload_failed");
    expect(row.creditUsed).toBeNull();
  });

  it("marks the row FAILED with a classified, user-safe message when the adapter's execute() throws", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    cropExecute.mockRejectedValueOnce(new CropExtractError("sharp extract failed: bad rect"));

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("crop_failed");
    expect(result.errorMessage).not.toContain("bad rect");

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("crop_failed");
  });

  it("marks the row FAILED (unregistered_tool) for a name with no registry entry, without touching any adapter", async () => {
    const { invocation } = await makeChatRunAndInvocation("not_a_real_tool", {});

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("unregistered_tool");
    expect(cropExecute).not.toHaveBeenCalled();
    expect(generateExecute).not.toHaveBeenCalled();
    expect(mergeExecute).not.toHaveBeenCalled();
  });

  it("never re-executes when re-entered on an already-terminal row (Trigger.dev retry, duplicate triggerAndWait)", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    await testDb.toolInvocation.update({
      where: { id: invocation.id },
      data: {
        status: "COMPLETED",
        resultUrls: ["https://out.example.com/already.png"],
        creditUsed: 0.04,
        finishedAt: new Date(),
      },
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result).toEqual({ status: "COMPLETED", resultUrls: ["https://out.example.com/already.png"], creditUsedApp: 0.04 });
    expect(cropExecute).not.toHaveBeenCalled();
  });

  it("reports the already-terminal row's own errorCode/errorMessage on re-entry after a FAILED settlement, without re-executing", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    await testDb.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "FAILED", errorCode: "timeout", errorMessage: "The tool did not finish within the expected time.", finishedAt: new Date() },
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("timeout");
    expect(cropExecute).not.toHaveBeenCalled();
  });

  // New required case (Task 4.2 per the migration plan): a row already
  // RUNNING on entry (not DISPATCHING, not terminal) means a prior attempt
  // died mid-execute — the engine's own side effects from that attempt are
  // not known to be safe to redo, so this must fail closed rather than
  // re-executing.
  it("fails closed with errorCode interrupted on RUNNING re-entry, without re-executing anything", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    await testDb.toolInvocation.update({
      where: { id: invocation.id },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, NO_SIGNAL);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("interrupted");
    expect(cropExecute).not.toHaveBeenCalled();
    expect(generateExecute).not.toHaveBeenCalled();
    expect(mergeExecute).not.toHaveBeenCalled();

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("interrupted");
  });

  it("records CANCELLED, not FAILED/timeout, when the outer signal is already aborted", async () => {
    const { invocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });
    const controller = new AbortController();
    controller.abort();
    cropExecute.mockImplementationOnce(async (_input: unknown, ctx: { signal: AbortSignal }) => {
      if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { artifacts: [] };
    });

    const result = await executeMediaTool({ toolInvocationId: invocation.id }, { signal: controller.signal });

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("cancelled");

    const row = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(row.status).toBe("CANCELLED");
  });

  // testing-policy.md's lifecycle-transition requirement: two different
  // in-process engines (cloudflare, sharp) executed back-to-back must each
  // get their own mkdtemp'd workDir, and that workDir must be gone by the
  // time execute() returns — no bleed between sequential invocations
  // sharing this task's own process. (Orchestration-level state — the
  // ToolInvocation/credit-hold independence turn.ts itself owns — is
  // covered separately in integration/tool-orchestration.test.ts's own
  // "generate_image then crop_image in the same turn" case.)
  it("generate_image then crop_image, run back-to-back — independent, self-cleaning workDirs, no bleed", async () => {
    const { invocation: generateInvocation } = await makeChatRunAndInvocation("generate_image", { prompt: "a cat" });
    const { invocation: cropInvocation } = await makeChatRunAndInvocation("crop_image", { image_url: "https://a.png" });

    let capturedGenerateWorkDir = "";
    let capturedCropWorkDir = "";
    generateExecute.mockImplementationOnce(async (_input: unknown, ctx: { workDir: string }) => {
      capturedGenerateWorkDir = ctx.workDir;
      expect(existsSync(ctx.workDir)).toBe(true); // exists while execute() is running
      return { artifacts: [{ kind: "bytes", body: new Uint8Array([1]), contentType: "image/png", filename: "g.png" }] };
    });
    cropExecute.mockImplementationOnce(async (_input: unknown, ctx: { workDir: string }) => {
      capturedCropWorkDir = ctx.workDir;
      expect(existsSync(ctx.workDir)).toBe(true);
      return { artifacts: [{ kind: "bytes", body: new Uint8Array([2]), contentType: "image/png", filename: "c.png" }] };
    });
    uploadGeneratedArtifacts
      .mockResolvedValueOnce({ resultUrls: ["https://cdn.example.com/g.png"], sourceUrls: [], ingestStatus: "INGESTED", assemblyId: "asm_g" })
      .mockResolvedValueOnce({ resultUrls: ["https://cdn.example.com/c.png"], sourceUrls: [], ingestStatus: "INGESTED", assemblyId: "asm_c" });

    const generateResult = await executeMediaTool({ toolInvocationId: generateInvocation.id }, NO_SIGNAL);
    const cropResult = await executeMediaTool({ toolInvocationId: cropInvocation.id }, NO_SIGNAL);

    expect(generateResult.status).toBe("COMPLETED");
    expect(cropResult.status).toBe("COMPLETED");
    expect(capturedGenerateWorkDir).not.toBe("");
    expect(capturedCropWorkDir).not.toBe("");
    expect(capturedGenerateWorkDir).not.toBe(capturedCropWorkDir);
    // Both cleaned up (tool.ts's own `finally`) — no leaked directory for
    // either invocation to bleed into a later one.
    expect(existsSync(capturedGenerateWorkDir)).toBe(false);
    expect(existsSync(capturedCropWorkDir)).toBe(false);

    const generateRow = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: generateInvocation.id } });
    const cropRow = await testDb.toolInvocation.findUniqueOrThrow({ where: { id: cropInvocation.id } });
    expect(generateRow.resultUrls).toEqual(["https://cdn.example.com/g.png"]);
    expect(cropRow.resultUrls).toEqual(["https://cdn.example.com/c.png"]);
  });
});
