import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json, noContent, notFound } from "@/lib/http";
import { ChatDTOSchema, UpdateChatRequestSchema } from "@/contracts/chats";
import { getOwnedChat, renameChat, softDeleteChat } from "@/services/chats";

export function OPTIONS() {
  return handleOptions();
}

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  const chat = await getOwnedChat(auth.userId, chatId);
  // Foreign, soft-deleted, and never-existed chats are indistinguishable
  // here on purpose — see the non-leaking 404 requirement in
  // S1-chat-surface.md.
  if (!chat) return notFound();

  return json(ChatDTOSchema.parse(chat));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsed = UpdateChatRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request body.", parsed.error.flatten());

  const { chatId } = await params;
  const chat = await renameChat(auth.userId, chatId, parsed.data.title);
  // Same non-leaking 404 as GET/DELETE — foreign, soft-deleted, and
  // never-existed chats are indistinguishable here on purpose.
  if (!chat) return notFound();

  return json(ChatDTOSchema.parse(chat));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  const deleted = await softDeleteChat(auth.userId, chatId);
  // Idempotent: an already-deleted (or foreign, or never-existed) chat
  // produces the same 404 as the first call — never a 500.
  if (!deleted) return notFound();

  return noContent();
}
