import { prisma } from "@/lib/db";
import { clampLimit, decodeCursor, encodeCursor } from "@/lib/cursor";
import { toAttachmentDTO } from "@/services/attachments";
import type { ContentBlock } from "@/contracts/common";
import type { MessageDTO, ListMessagesQuerySchema } from "@/contracts/messages";
import type { Prisma } from "@/generated/prisma/client";
import type { z } from "zod";

type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

type MessageWithAttachments = Prisma.MessageGetPayload<{ include: { attachments: true } }>;

function toDTO(message: MessageWithAttachments): MessageDTO {
  return {
    id: message.id,
    chatId: message.chatId,
    // Prisma enum members are already validated at write time by the
    // contract; cast is safe, not `any`.
    role: message.role as MessageDTO["role"],
    status: message.status as MessageDTO["status"],
    content: message.content as ContentBlock[],
    attachments: message.attachments.map(toAttachmentDTO),
    createdAt: message.createdAt.toISOString(),
  };
}

export async function listMessages(chatId: string, query: ListMessagesQuery) {
  const limit = clampLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await prisma.message.findMany({
    where: {
      chatId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { attachments: { orderBy: { orderIndex: "asc" } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;

  return { items: page.map(toDTO), nextCursor };
}
