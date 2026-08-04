import { describe, it, expect } from "vitest";
import {
  RequestUploadParamsRequestSchema,
  RequestUploadParamsBatchRequestSchema,
  CompleteAttachmentRequestSchema,
  AttachmentDTOSchema,
  ListAttachmentsQuerySchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "@/contracts/attachments";
import { CreateMessageRequestSchema } from "@/contracts/messages";

const validFile = { fileName: "photo.png", mimeType: "image/png", byteSize: 1024 };

describe("RequestUploadParamsRequestSchema", () => {
  it("accepts a valid file descriptor", () => {
    expect(RequestUploadParamsRequestSchema.safeParse(validFile).success).toBe(true);
  });

  it("rejects a byteSize over the 0.5GB per-file limit", () => {
    const result = RequestUploadParamsRequestSchema.safeParse({ ...validFile, byteSize: MAX_ATTACHMENT_BYTES + 1 });
    expect(result.success).toBe(false);
  });

  it("rejects a disallowed MIME type", () => {
    const result = RequestUploadParamsRequestSchema.safeParse({ ...validFile, mimeType: "application/pdf" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty fileName", () => {
    const result = RequestUploadParamsRequestSchema.safeParse({ ...validFile, fileName: "" });
    expect(result.success).toBe(false);
  });
});

describe("RequestUploadParamsBatchRequestSchema", () => {
  it("accepts a batch at the max size (10 files)", () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => validFile);
    const result = RequestUploadParamsBatchRequestSchema.safeParse({ chatId: "chat_1", files });
    expect(result.success).toBe(true);
  });

  it("rejects a batch exceeding MAX_ATTACHMENTS_PER_MESSAGE", () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => validFile);
    const result = RequestUploadParamsBatchRequestSchema.safeParse({ chatId: "chat_1", files });
    expect(result.success).toBe(false);
  });

  it("rejects an empty files array", () => {
    const result = RequestUploadParamsBatchRequestSchema.safeParse({ chatId: "chat_1", files: [] });
    expect(result.success).toBe(false);
  });

  // S4: chatId is deliberately optional — the empty-state composer can
  // attach a file before any chat exists (see the "Optional" comment on
  // RequestUploadParamsBatchRequestSchema in src/contracts/attachments.ts);
  // the row stays chatless until the first send binds it.
  it("accepts a missing chatId (chatless/draft upload)", () => {
    const result = RequestUploadParamsBatchRequestSchema.safeParse({ files: [validFile] });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string chatId", () => {
    const result = RequestUploadParamsBatchRequestSchema.safeParse({ chatId: "", files: [validFile] });
    expect(result.success).toBe(false);
  });
});

describe("CompleteAttachmentRequestSchema", () => {
  it("accepts a non-empty assemblyId", () => {
    expect(CompleteAttachmentRequestSchema.safeParse({ assemblyId: "asm_1" }).success).toBe(true);
  });

  it("rejects an empty assemblyId", () => {
    expect(CompleteAttachmentRequestSchema.safeParse({ assemblyId: "" }).success).toBe(false);
  });
});

describe("AttachmentDTOSchema", () => {
  const baseDTO = {
    id: "att_1",
    chatId: "chat_1",
    messageId: null,
    orderIndex: 0,
    status: "READY" as const,
    mimeType: "image/png",
    byteSize: 1024,
    fileName: "photo.png",
    resultUrl: "https://cdn.example.com/photo.png",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "uploaded" as const,
  };

  it("accepts a fully-populated READY DTO", () => {
    expect(AttachmentDTOSchema.safeParse(baseDTO).success).toBe(true);
  });

  it("accepts a PENDING DTO with all nullable fields null", () => {
    const result = AttachmentDTOSchema.safeParse({
      ...baseDTO,
      status: "PENDING",
      mimeType: null,
      byteSize: null,
      fileName: null,
      resultUrl: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status value", () => {
    expect(AttachmentDTOSchema.safeParse({ ...baseDTO, status: "BOGUS" }).success).toBe(false);
  });

  it("rejects a non-URL resultUrl", () => {
    expect(AttachmentDTOSchema.safeParse({ ...baseDTO, resultUrl: "not-a-url" }).success).toBe(false);
  });

  it("rejects a negative orderIndex", () => {
    expect(AttachmentDTOSchema.safeParse({ ...baseDTO, orderIndex: -1 }).success).toBe(false);
  });

  it("accepts a generated DTO (source: generated, no owning Attachment row)", () => {
    const result = AttachmentDTOSchema.safeParse({ ...baseDTO, id: "inv_1:0", source: "generated" });
    expect(result.success).toBe(true);
  });

  it("rejects a DTO missing source", () => {
    const { source: _source, ...withoutSource } = baseDTO;
    expect(AttachmentDTOSchema.safeParse(withoutSource).success).toBe(false);
  });

  it("rejects an unknown source value", () => {
    expect(AttachmentDTOSchema.safeParse({ ...baseDTO, source: "bogus" }).success).toBe(false);
  });
});

describe("ListAttachmentsQuerySchema", () => {
  it("coerces unbound=true from a query-string value", () => {
    const result = ListAttachmentsQuerySchema.safeParse({ unbound: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unbound).toBe(true);
  });

  it("accepts an optional chatId", () => {
    expect(ListAttachmentsQuerySchema.safeParse({ chatId: "chat_1" }).success).toBe(true);
  });

  it("accepts an empty query (both filters omitted)", () => {
    expect(ListAttachmentsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts source=generated", () => {
    const result = ListAttachmentsQuerySchema.safeParse({ unbound: "true", source: "generated" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.source).toBe("generated");
  });

  it("rejects an unknown source value", () => {
    expect(ListAttachmentsQuerySchema.safeParse({ source: "bogus" }).success).toBe(false);
  });
});

describe("CreateMessageRequestSchema — S4 attachment-only sends", () => {
  it("accepts an attachment-only send (empty content, at least one attachment)", () => {
    const result = CreateMessageRequestSchema.safeParse({ content: [], attachments: [{ id: "att_1" }] });
    expect(result.success).toBe(true);
  });

  it("rejects empty content AND empty/omitted attachments together", () => {
    const result = CreateMessageRequestSchema.safeParse({ content: [] });
    expect(result.success).toBe(false);
  });

  it("accepts attachments at the max cap (10)", () => {
    const attachments = Array.from({ length: 10 }, (_, i) => ({ id: `att_${i}` }));
    const result = CreateMessageRequestSchema.safeParse({ content: [], attachments });
    expect(result.success).toBe(true);
  });

  it("rejects more than 10 attachments", () => {
    const attachments = Array.from({ length: 11 }, (_, i) => ({ id: `att_${i}` }));
    const result = CreateMessageRequestSchema.safeParse({ content: [], attachments });
    expect(result.success).toBe(false);
  });

  it("accepts text content plus attachments together", () => {
    const result = CreateMessageRequestSchema.safeParse({
      content: [{ type: "text", text: "check this out" }],
      attachments: [{ id: "att_1" }],
    });
    expect(result.success).toBe(true);
  });
});
