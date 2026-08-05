import { authenticate } from "@/lib/auth";
import { handleOptions, json, notFound } from "@/lib/http";
import { AttachmentIdParamSchema, AttachmentDTOSchema } from "@/contracts/attachments";
import { cancelAttachment, deleteAttachment } from "@/services/attachments";

export function OPTIONS() {
  return handleOptions();
}

/**
 * DELETE /api/v1/attachments/:attachmentId — cancel mid-upload for a
 * PENDING row; permanently delete a READY/FAILED/CANCELLED unbound row
 * (the media-library "delete" action) otherwise. Never touches a row
 * already bound to a sent message (see services/attachments.ts).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsedParams = AttachmentIdParamSchema.safeParse(await params);
  if (!parsedParams.success) return notFound();

  const cancelled = await cancelAttachment(auth.userId, parsedParams.data.attachmentId);
  const attachment = cancelled ?? (await deleteAttachment(auth.userId, parsedParams.data.attachmentId));
  if (!attachment) return notFound();

  return json(AttachmentDTOSchema.parse(attachment));
}
