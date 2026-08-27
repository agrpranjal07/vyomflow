import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, insufficientCredits, json, notFound } from "@/lib/http";
import { RequestUploadParamsBatchRequestSchema, RequestUploadParamsResponseSchema } from "@/contracts/attachments";
import { getOwnedChat } from "@/services/chats";
import { requestUploadParams, AttachmentLimitError } from "@/services/attachments";
import { getCreditSummary } from "@/services/credits";

export function OPTIONS() {
  return handleOptions();
}

/**
 * POST /api/v1/attachments/upload-params — mints one signed direct-upload
 * Assembly per file (never a single shared signature for the batch — see
 * ../../../../../server/transloadit/upload.ts's header comment) and creates
 * one PENDING Attachment row per file. Rejects the whole batch, writing
 * nothing, on any app-level limit violation (R10: reject before
 * persistence).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsed = RequestUploadParamsBatchRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request.", parsed.error.flatten());

  const { chatId, files } = parsed.data;
  // chatId is optional — the empty-state composer attaches a file before
  // any chat exists (see RequestUploadParamsBatchRequestSchema's comment);
  // only verify ownership when a chatId was actually supplied.
  if (chatId && !(await getOwnedChat(auth.userId, chatId))) return notFound();

  // Uploads exist only to feed paid tools — block them at zero balance so a
  // spent-out user doesn't attach files they can never use.
  const { available } = await getCreditSummary(auth.userId);
  if (Number(available) <= 0) {
    return insufficientCredits("Insufficient credits to upload attachments.");
  }

  try {
    const uploads = await requestUploadParams({ chatId, ownerId: auth.userId, files });
    return json(RequestUploadParamsResponseSchema.parse({ uploads }), 201);
  } catch (error) {
    if (error instanceof AttachmentLimitError) return badRequest(error.message);
    throw error;
  }
}
