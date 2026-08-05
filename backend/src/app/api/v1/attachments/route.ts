import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { ListAttachmentsQuerySchema, ListAttachmentsResponseSchema } from "@/contracts/attachments";
import { listAttachments } from "@/services/attachments";
import { encodeCursor, decodeCursor, clampLimit } from "@/lib/cursor";

export function OPTIONS() {
  return handleOptions();
}

/**
 * GET /api/v1/attachments — chat-scoped bound attachments (?chatId=) or the
 * caller's unbound media library (?unbound=true), per the S4 implementation
 * plan §4 "unbound READY rows are the library, no new entity."
 */
export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = ListAttachmentsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const limit = clampLimit(parsed.data.limit);
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;

  const page = await listAttachments({
    ownerId: auth.userId,
    chatId: parsed.data.chatId,
    unbound: parsed.data.unbound,
    source: parsed.data.source,
    limit,
    cursor,
  });

  return json(
    ListAttachmentsResponseSchema.parse({
      items: page.items,
      nextCursor: page.hasMore && page.lastCreatedAt && page.lastId ? encodeCursor({ createdAt: page.lastCreatedAt, id: page.lastId }) : null,
    }),
  );
}
