import { describe, it, expect } from "vitest";
import { CreateChatRequestSchema, ChatIdParamSchema } from "@/contracts/chats";
import {
  CreateMessageRequestSchema,
  MAX_MESSAGE_TEXT_LENGTH,
  OPENROUTER_FREE_MODEL,
} from "@/contracts/messages";
import {
  AgentRunDTOSchema,
  SendTurnResponseSchema,
  TurnStreamPartSchema,
} from "@/contracts/runs";

describe("CreateChatRequestSchema", () => {
  it("accepts a valid title", () => {
    expect(CreateChatRequestSchema.safeParse({ title: "Hello" }).success).toBe(true);
  });

  it("accepts an omitted title", () => {
    expect(CreateChatRequestSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an empty-string title", () => {
    expect(CreateChatRequestSchema.safeParse({ title: "" }).success).toBe(false);
  });
});

describe("ChatIdParamSchema", () => {
  it("rejects a malformed (empty) chat id", () => {
    expect(ChatIdParamSchema.safeParse({ chatId: "" }).success).toBe(false);
  });
});

describe("CreateMessageRequestSchema", () => {
  it("accepts a valid text message under the limit", () => {
    const result = CreateMessageRequestSchema.safeParse({ content: [{ type: "text", text: "hi" }] });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-text message", () => {
    const result = CreateMessageRequestSchema.safeParse({ content: [{ type: "text", text: "" }] });
    expect(result.success).toBe(false);
  });

  it("rejects a message over the length limit", () => {
    const result = CreateMessageRequestSchema.safeParse({
      content: [{ type: "text", text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1) }],
    });
    expect(result.success).toBe(false);
  });

  it("defaults attachments to an empty array", () => {
    const result = CreateMessageRequestSchema.parse({ content: [{ type: "text", text: "hi" }] });
    expect(result.attachments).toEqual([]);
  });

  it("rejects a malformed content block (unknown type)", () => {
    const result = CreateMessageRequestSchema.safeParse({ content: [{ type: "bogus" }] });
    expect(result.success).toBe(false);
  });

  // S2 model-selection validation — exactly four outcomes
  // (S2-streaming-turn.md), never collapsed into one another.
  describe("model-selection validation", () => {
    const content = [{ type: "text" as const, text: "hi" }];

    it("accepts an absent model field (defaults downstream)", () => {
      const result = CreateMessageRequestSchema.safeParse({ content });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.model).toBeUndefined();
    });

    it("accepts model === openrouter/free", () => {
      const result = CreateMessageRequestSchema.safeParse({ content, model: OPENROUTER_FREE_MODEL });
      expect(result.success).toBe(true);
    });

    it("rejects a paid/unsupported model id", () => {
      const result = CreateMessageRequestSchema.safeParse({ content, model: "openai/gpt-4o" });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed model field (empty string)", () => {
      const result = CreateMessageRequestSchema.safeParse({ content, model: "" });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed model field (whitespace-only string)", () => {
      const result = CreateMessageRequestSchema.safeParse({ content, model: "   " });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed model field (wrong type)", () => {
      const result = CreateMessageRequestSchema.safeParse({ content, model: 42 });
      expect(result.success).toBe(false);
    });

    it("malformed is distinct from absent — both reject, but for different reasons", () => {
      const absent = CreateMessageRequestSchema.safeParse({ content });
      const malformed = CreateMessageRequestSchema.safeParse({ content, model: "" });
      expect(absent.success).toBe(true);
      expect(malformed.success).toBe(false);
    });
  });
});

describe("runs contracts", () => {
  const baseRun = {
    id: "run_1",
    chatId: "chat_1",
    status: "running" as const,
    userMessageId: "msg_1",
    assistantMessageId: null,
    lastStreamIndex: -1,
    cancelRequestedAt: null,
    requestedModel: OPENROUTER_FREE_MODEL,
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
  };

  it("AgentRunDTOSchema accepts a fresh queued/running run with lastStreamIndex -1", () => {
    expect(AgentRunDTOSchema.safeParse(baseRun).success).toBe(true);
  });

  it("AgentRunDTOSchema rejects an unknown status value", () => {
    expect(AgentRunDTOSchema.safeParse({ ...baseRun, status: "bogus" }).success).toBe(false);
  });

  it("SendTurnResponseSchema accepts the full send envelope", () => {
    const result = SendTurnResponseSchema.safeParse({
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
      run: baseRun,
      realtime: {
        runId: "run_1",
        streamKey: "assistant",
        accessToken: "pat_abc",
        expiresAt: new Date().toISOString(),
      },
    });
    expect(result.success).toBe(true);
  });

  it("TurnStreamPartSchema rejects a negative index", () => {
    expect(TurnStreamPartSchema.safeParse({ index: -1, type: "text", delta: "hi" }).success).toBe(false);
  });

  it("TurnStreamPartSchema accepts a text part at index 0", () => {
    expect(TurnStreamPartSchema.safeParse({ index: 0, type: "text", delta: "hi" }).success).toBe(true);
  });

  it("TurnStreamPartSchema accepts a tool part", () => {
    const result = TurnStreamPartSchema.safeParse({
      index: 1,
      type: "tool",
      toolInvocationId: "ti_1",
      name: "crop_image",
      status: "RUNNING",
    });
    expect(result.success).toBe(true);
  });

  it("TurnStreamPartSchema rejects a part missing the discriminant", () => {
    expect(TurnStreamPartSchema.safeParse({ index: 0, delta: "hi" }).success).toBe(false);
  });
});
