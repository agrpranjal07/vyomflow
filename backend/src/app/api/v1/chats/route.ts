import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json } from "@/lib/http";
import { CreateChatRequestSchema, ListChatsQuerySchema, ChatDTOSchema, ListChatsResponseSchema } from "@/contracts/chats";
import { createChat, listChats } from "@/services/chats";

export function OPTIONS() {
  return handleOptions();
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const parsed = CreateChatRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request body.", parsed.error.flatten());

  const chat = await createChat(auth.userId, parsed.data.title);
  return json(ChatDTOSchema.parse(chat), 201);
}

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const parsed = ListChatsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const page = await listChats(auth.userId, parsed.data);
  return json(ListChatsResponseSchema.parse(page));
}
