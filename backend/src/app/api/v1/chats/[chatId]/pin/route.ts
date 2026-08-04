import { authenticate } from "@/lib/auth";
import { handleOptions, json, notFound } from "@/lib/http";
import { ChatDTOSchema } from "@/contracts/chats";
import { setPinned } from "@/services/chats";

export function OPTIONS() {
  return handleOptions();
}

export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  const chat = await setPinned(auth.userId, chatId, true);
  if (!chat) return notFound();

  return json(ChatDTOSchema.parse(chat));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  const chat = await setPinned(auth.userId, chatId, false);
  if (!chat) return notFound();

  return json(ChatDTOSchema.parse(chat));
}
