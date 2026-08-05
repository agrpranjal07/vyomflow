import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json, notFound } from "@/lib/http";
import { AttachmentIdParamSchema, AttachmentDTOSchema, CompleteAttachmentRequestSchema } from "@/contracts/attachments";
import { completeAttachment, AttachmentNotFoundError } from "@/services/attachments";

export function OPTIONS() {
  return handleOptions();
}

/**
 * POST /api/v1/attachments/:attachmentId/complete — server-verified
 * completion (S4 plan §4: fetches the Assembly status itself, never trusts
 * a client-supplied result URL). Idempotent against duplicate completion.
 */
export async function POST(req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsedParams = AttachmentIdParamSchema.safeParse(await params);
  if (!parsedParams.success) return notFound();

  const parsedBody = CompleteAttachmentRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) return badRequest("Invalid request.", parsedBody.error.flatten());

  try {
    const attachment = await completeAttachment({
      ownerId: auth.userId,
      attachmentId: parsedParams.data.attachmentId,
      assemblyId: parsedBody.data.assemblyId,
    });
    return json(AttachmentDTOSchema.parse(attachment));
  } catch (error) {
    if (error instanceof AttachmentNotFoundError) return notFound();
    throw error;
  }
}
