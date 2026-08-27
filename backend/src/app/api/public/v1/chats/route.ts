import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { badRequest, publicHandleOptions, publicJson } from "@/lib/http";
import { CreateChatRequestSchema, ListChatsQuerySchema, ChatDTOSchema, ListChatsResponseSchema } from "@/contracts/chats";
import { createChat, listChats } from "@/services/chats";

export function OPTIONS() {
  return publicHandleOptions();
}

export async function POST(req: Request) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "chats:write");
  if (scopeErr) return scopeErr;

  const parsed = CreateChatRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid request body.", parsed.error.flatten(), "public");

  const chat = await createChat(auth.userId, parsed.data.title);
  return publicJson(ChatDTOSchema.parse(chat), 201);
}

export async function GET(req: Request) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "chats:read");
  if (scopeErr) return scopeErr;

  const url = new URL(req.url);
  const parsed = ListChatsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten(), "public");

  const page = await listChats(auth.userId, parsed.data);
  return publicJson(ListChatsResponseSchema.parse(page));
}
