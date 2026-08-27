/**
 * Orchestrates the send route's one atomic DB step: create the user
 * message, create the AgentRun row, reserve the credit hold — all inside
 * one transaction (00-master-spec.md §6: "message-create + run-dispatch-
 * record ... execute inside a single Prisma interactive transaction").
 * Dispatch to Trigger.dev happens *outside* this transaction (network call
 * — see the send route), which then patches `triggerRunId` on afterward.
 */
import { prisma } from "@/lib/db";
import { Prisma as PrismaRuntime } from "@/generated/prisma/client";
import type { AgentRun } from "@/generated/prisma/client";
import type { ContentBlock } from "@/contracts/common";
import type { AttachmentDTO } from "@/contracts/attachments";
import type { MessageDTO } from "@/contracts/messages";
import { reserveHold, InsufficientCreditsError } from "@/services/credits";
import { reconcileIfStale } from "@/services/runs";
import { bindAttachmentsToMessage, toAttachmentDTO } from "@/services/attachments";
import { CREDIT_LLM_MIN_ADMISSION } from "@/lib/config";
import { DEFAULT_CHAT_TITLE, deriveTitleFromContent } from "@/services/chats";

export class ActiveRunExistsError extends Error {
  constructor() {
    super("A response is already in progress in this chat.");
    this.name = "ActiveRunExistsError";
  }
}

export { InsufficientCreditsError };

function toMessageDTO(
  message: { id: string; chatId: string; role: string; status: string; content: unknown; createdAt: Date },
  attachments: AttachmentDTO[],
): MessageDTO {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role as MessageDTO["role"],
    status: message.status as MessageDTO["status"],
    content: message.content as ContentBlock[],
    attachments,
    createdAt: message.createdAt.toISOString(),
  };
}

// Namespaces a caller-supplied `Idempotency-Key` header (S8 public API)
// away from the internally-synthesized `send:${chatId}:${message.id}` key
// below, and scopes it per chat — the same header value reused across two
// different chats must not collide.
function externalIdempotencyKey(chatId: string, key: string): string {
  return `ext:${chatId}:${key}`;
}

/**
 * Idempotent-replay lookup for the public send-message route: if a run
 * already exists for this chat + caller-supplied Idempotency-Key, returns
 * its persisted message/run so a retrying client is never double-charged
 * or double-dispatched. Returns null on first sight of the key.
 */
export async function findTurnByIdempotencyKey(
  chatId: string,
  key: string,
): Promise<{ message: MessageDTO; run: AgentRun } | null> {
  const run = await prisma.agentRun.findUnique({ where: { idempotencyKey: externalIdempotencyKey(chatId, key) } });
  if (!run) return null;

  const message = await prisma.message.findUniqueOrThrow({ where: { id: run.userMessageId } });
  const attachments = (
    await prisma.attachment.findMany({ where: { messageId: message.id }, orderBy: { orderIndex: "asc" } })
  ).map(toAttachmentDTO);
  return { message: toMessageDTO(message, attachments), run };
}

export async function createTurn(params: {
  chatId: string;
  userId: string;
  content: ContentBlock[];
  attachmentIds: string[];
  requestedModel: string;
  // S8 public API — caller-supplied `Idempotency-Key` header value, stored
  // as this run's idempotencyKey instead of the internally-synthesized one
  // so a later `findTurnByIdempotencyKey` call can find it. Optional and
  // additive: existing internal callers (the `/api/v1` send route) don't
  // pass it and keep the original synthesized-key behavior unchanged.
  externalIdempotencyKey?: string;
}): Promise<{ message: MessageDTO; run: AgentRun }> {
  const { chatId, userId, content, attachmentIds, requestedModel } = params;

  // Reconcile any known-active run for this chat before attempting the
  // insert — turns a genuinely-dead run into a usable slot without relying
  // on the constraint-violation path for the common case (S2 plan §F).
  // The partial-unique-index catch below remains the race-safety net for
  // two concurrent sends that both pass this check simultaneously.
  const existingActive = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: ["queued", "running", "waiting"] } },
  });
  if (existingActive) await reconcileIfStale(existingActive);

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: { chatId, role: "user", status: "complete", content: content as unknown as PrismaRuntime.InputJsonValue },
    });
    await bindAttachmentsToMessage(tx, { ownerId: userId, chatId, messageId: message.id, attachmentIds });
    await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });

    // Auto-title from the first prompt (mirrors the reference product's
    // sidebar behavior). Guarded by `title: DEFAULT_CHAT_TITLE` so this
    // only ever fires once, per chat, and never clobbers a title the user
    // set explicitly at creation or via a later rename (updateMany's
    // affected-row count is 0 in either of those cases, silently — no
    // error, no second write).
    const autoTitle = deriveTitleFromContent(content);
    if (autoTitle) {
      await tx.chat.updateMany({
        where: { id: chatId, title: DEFAULT_CHAT_TITLE },
        data: { title: autoTitle },
      });
    }

    let run: AgentRun;
    try {
      run = await tx.agentRun.create({
        data: {
          chatId,
          idempotencyKey: params.externalIdempotencyKey
            ? externalIdempotencyKey(chatId, params.externalIdempotencyKey)
            : `send:${chatId}:${message.id}`,
          userMessageId: message.id,
          requestedModel,
        },
      });
    } catch (error) {
      // The only realistic P2002 source here is the partial-unique active-
      // run index — `idempotencyKey`/`userMessageId` are keyed on this
      // message's own fresh id and cannot collide.
      if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ActiveRunExistsError();
      }
      throw error;
    }

    await reserveHold(tx, { runId: run.id, userId, amount: CREDIT_LLM_MIN_ADMISSION });

    const boundAttachments =
      attachmentIds.length === 0
        ? []
        : (await tx.attachment.findMany({ where: { messageId: message.id }, orderBy: { orderIndex: "asc" } })).map(toAttachmentDTO);

    return { message: toMessageDTO(message, boundAttachments), run };
  });
}
