import { prisma } from "@/lib/db";
import { clampLimit, decodeCursor, encodeCursor } from "@/lib/cursor";
import type { ChatDTO, ListChatsQuery } from "@/contracts/chats";
import type { Prisma } from "@/generated/prisma/client";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";

/** Escapes LIKE/ILIKE wildcard characters so a search term is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Chat ids (within this owner's own chats) whose message content matches
 * `q`. Raw SQL rather than Prisma's JSON `path` filter — the latter is not
 * supported against jsonb array content in this Prisma version (verified
 * via Context7: path-based JSON where-filtering is explicitly not ported
 * for the postgres driver adapter). `SELECT DISTINCT` on `m."chatId"`
 * guarantees each chat appears at most once even with many matching
 * messages — an inner JOIN in the caller's main query would duplicate rows
 * and corrupt the (createdAt, id) cursor; this subquery avoids that by
 * construction.
 */
async function chatIdsWithMatchingMessageContent(ownerId: string, q: string): Promise<string[]> {
  const pattern = `%${escapeLike(q)}%`;
  const rows = await prisma.$queryRaw<{ chatId: string }[]>(
    PrismaRuntime.sql`
      SELECT DISTINCT m."chatId" AS "chatId"
      FROM "messages" m
      JOIN "chats" c ON c.id = m."chatId"
      WHERE c."ownerId" = ${ownerId}
        AND c."deletedAt" IS NULL
        AND m.content::text ILIKE ${pattern} ESCAPE '\\'
    `,
  );
  return rows.map((r) => r.chatId);
}

function toDTO(
  chat: {
    id: string;
    title: string;
    pinnedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  activeRunId?: string | null,
): ChatDTO {
  return {
    id: chat.id,
    title: chat.title,
    pinnedAt: chat.pinnedAt ? chat.pinnedAt.toISOString() : null,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    ...(activeRunId !== undefined ? { activeRunId } : {}),
  };
}

export async function createChat(ownerId: string, title: string | undefined) {
  const chat = await prisma.chat.create({
    data: { ownerId, title: title ?? DEFAULT_CHAT_TITLE },
  });
  return toDTO(chat);
}

const AUTO_TITLE_MAX_LENGTH = 60;

/**
 * Derives a chat title from a message's text content — collapse whitespace,
 * truncate with a trailing ellipsis. Used to auto-title a chat from its
 * first prompt (mirrors the reference product's sidebar behavior); never
 * called for a chat whose title isn't still the default (see `renameChat`
 * and the guarded update in `send-turn.ts`).
 */
export function deriveTitleFromContent(content: { type: string; text?: string }[]): string | null {
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > AUTO_TITLE_MAX_LENGTH ? `${text.slice(0, AUTO_TITLE_MAX_LENGTH).trimEnd()}…` : text;
}

/**
 * Cursor-paginated, ownership-scoped chat list. Supports `q` (title OR
 * message-content substring match, deduplicated via an EXISTS subquery so a
 * chat with many matching messages appears once) and `pinned` (a filter,
 * never a re-ordering — keeps the (createdAt, id) cursor monotonic).
 */
export async function listChats(ownerId: string, query: ListChatsQuery) {
  const limit = clampLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const where: Prisma.ChatWhereInput = {
    ownerId,
    deletedAt: null,
    // A chat row is created early (e.g. to scope an attachment upload
    // before any text is sent — see empty-state.tsx's ensureChatId) but
    // must stay invisible in the sidebar until it actually has content,
    // matching the reference product's "New chat only appears on send"
    // behavior.
    messages: { some: {} },
  };

  if (query.pinned) {
    where.pinnedAt = { not: null };
  }

  if (query.q) {
    const q = query.q;
    const contentMatchChatIds = await chatIdsWithMatchingMessageContent(ownerId, q);
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      ...(contentMatchChatIds.length > 0 ? [{ id: { in: contentMatchChatIds } }] : []),
    ];
  }

  if (cursor) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      },
    ];
  }

  const rows = await prisma.chat.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items: page.map((chat) => toDTO(chat)), nextCursor };
}

/**
 * Returns null for foreign, soft-deleted, or never-existed chats alike.
 * Includes `activeRunId` (S2 reload-recovery primitive) — at most one
 * non-terminal run per chat is guaranteed by the partial-unique index, so
 * `findFirst` is always correct here, never ambiguous.
 */
export async function getOwnedChat(ownerId: string, chatId: string) {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, ownerId, deletedAt: null },
  });
  if (!chat) return null;

  const activeRun = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: ["queued", "running", "waiting"] } },
    select: { id: true },
  });
  return toDTO(chat, activeRun?.id ?? null);
}

async function ownedChatExists(ownerId: string, chatId: string): Promise<boolean> {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, ownerId, deletedAt: null },
    select: { id: true },
  });
  return chat !== null;
}

export async function setPinned(ownerId: string, chatId: string, pinned: boolean) {
  if (!(await ownedChatExists(ownerId, chatId))) return null;
  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: { pinnedAt: pinned ? new Date() : null },
  });
  return toDTO(chat);
}

/** The literal default set by `createChat` — also the guard value for auto-titling. */
export const DEFAULT_CHAT_TITLE = "New chat";

export async function renameChat(ownerId: string, chatId: string, title: string) {
  if (!(await ownedChatExists(ownerId, chatId))) return null;
  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: { title },
  });
  return toDTO(chat);
}

/**
 * Soft delete. Idempotent: deleting an already-deleted (or foreign, or
 * never-existed) chat returns the same `false` — callers translate that
 * uniformly into the shared non-leaking 404, never a 500.
 */
export async function softDeleteChat(ownerId: string, chatId: string): Promise<boolean> {
  if (!(await ownedChatExists(ownerId, chatId))) return false;
  await prisma.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
  return true;
}
