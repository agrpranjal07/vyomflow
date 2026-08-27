import { describe, it, expect } from "vitest";
import { toPublicSendTurnResponse, PublicSendTurnResponseSchema } from "@/public-api/mappers";
import type { SendTurnResponse } from "@/contracts/runs";

function fixture(): SendTurnResponse {
  return {
    chatId: "chat_1",
    message: {
      id: "msg_1",
      chatId: "chat_1",
      role: "user",
      status: "complete",
      content: [{ type: "text", text: "hi" }],
      attachments: [],
      createdAt: new Date().toISOString(),
    },
    run: {
      id: "run_1",
      chatId: "chat_1",
      status: "queued",
      userMessageId: "msg_1",
      assistantMessageId: null,
      lastStreamIndex: -1,
      cancelRequestedAt: null,
      requestedModel: "openrouter/free",
      resolvedModel: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      toolInvocations: [],
      totalCreditsUsed: 0,
      pendingWaitpoint: null,
    },
    realtime: {
      runId: "trigger_run_1",
      streamKey: "assistant",
      accessToken: "super-secret-trigger-token",
      expiresAt: new Date().toISOString(),
    },
  };
}

// Recursively asserts no key anywhere in the object is named accessToken or
// streamKey — the exact leak this mapper exists to prevent (Phase 4's "why
// not just hand out the Trigger realtime token").
function assertNoLeakedKeys(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoLeakedKeys(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      expect(key).not.toBe("accessToken");
      expect(key).not.toBe("streamKey");
      assertNoLeakedKeys(nested);
    }
  }
}

describe("toPublicSendTurnResponse", () => {
  it("strips realtime.accessToken/streamKey and replaces them with a stream pointer", () => {
    const mapped = toPublicSendTurnResponse(fixture());

    assertNoLeakedKeys(mapped);
    expect(mapped).not.toHaveProperty("realtime");
    expect(mapped.stream.url).toContain(`/api/public/v1/runs/${mapped.run.id}/stream`);
    expect(mapped.stream.fromIndex).toBe(0);
  });

  it("re-parses through PublicSendTurnResponseSchema (no accessToken/streamKey field in the schema itself)", () => {
    const mapped = toPublicSendTurnResponse(fixture());
    const reparsed = PublicSendTurnResponseSchema.parse(mapped);
    assertNoLeakedKeys(reparsed);
  });
});
