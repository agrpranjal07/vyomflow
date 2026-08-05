import type { Fetcher } from "@/lib/api-client";
import {
  RequestUploadParamsResponseSchema,
  CompleteAttachmentRequestSchema,
  AttachmentDTOSchema,
  ListAttachmentsResponseSchema,
  type RequestUploadParamsBatchRequest,
  type RequestUploadParamsResponse,
  type AttachmentDTO,
  type ListAttachmentsQuery,
  type ListAttachmentsResponse,
} from "@/contracts/attachments";

export async function requestUploadParams(
  fetcher: Fetcher,
  body: RequestUploadParamsBatchRequest,
): Promise<RequestUploadParamsResponse> {
  const raw = await fetcher("/api/v1/attachments/upload-params", { method: "POST", body: JSON.stringify(body) });
  return RequestUploadParamsResponseSchema.parse(raw);
}

export async function completeAttachment(fetcher: Fetcher, attachmentId: string, assemblyId: string): Promise<AttachmentDTO> {
  const body = CompleteAttachmentRequestSchema.parse({ assemblyId });
  const raw = await fetcher(`/api/v1/attachments/${attachmentId}/complete`, { method: "POST", body: JSON.stringify(body) });
  return AttachmentDTOSchema.parse(raw);
}

export async function cancelAttachment(fetcher: Fetcher, attachmentId: string): Promise<AttachmentDTO> {
  const raw = await fetcher(`/api/v1/attachments/${attachmentId}`, { method: "DELETE" });
  return AttachmentDTOSchema.parse(raw);
}

/** Same endpoint as cancelAttachment — the backend hard-deletes a non-PENDING unbound row (media-library delete). */
export const deleteAttachment = cancelAttachment;

export async function listAttachments(fetcher: Fetcher, query: ListAttachmentsQuery): Promise<ListAttachmentsResponse> {
  const params = new URLSearchParams();
  if (query.chatId) params.set("chatId", query.chatId);
  if (query.unbound !== undefined) params.set("unbound", String(query.unbound));
  if (query.source) params.set("source", query.source);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const raw = await fetcher(`/api/v1/attachments?${params.toString()}`);
  return ListAttachmentsResponseSchema.parse(raw);
}
