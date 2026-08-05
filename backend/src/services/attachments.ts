/**
 * S4 — Attachment persistence + Transloadit direct-upload orchestration.
 * Mirrors src/services/tool-invocations.ts's shape (DTO mapper + narrow
 * status-transition functions) and src/services/chats.ts's ownership
 * pattern (`ownedChatExists`-style existence check, non-leaking null).
 */
import { prisma } from "@/lib/db";
import type { AttachmentDTO } from "@/contracts/attachments";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MAX_MONTHLY_UPLOAD_BYTES } from "@/contracts/attachments";
import { signUploadAssemblyParams } from "@/server/transloadit/upload";
import { awaitAssembly, TransloaditRequestError, TransloaditTimeoutError } from "@/server/transloadit/client";
import { TRANSLOADIT_API_BASE_URL, TRANSLOADIT_UPLOAD_TEMPLATE_ID } from "@/lib/config";
import type { Prisma } from "@/generated/prisma/client";

type AttachmentRow = {
  id: string;
  chatId: string | null;
  messageId: string | null;
  orderIndex: number;
  status: string;
  mimeType: string | null;
  byteSize: number | null;
  fileName: string | null;
  resultUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toAttachmentDTO(row: AttachmentRow): AttachmentDTO {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    orderIndex: row.orderIndex,
    status: row.status as AttachmentDTO["status"],
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    fileName: row.fileName,
    resultUrl: row.resultUrl,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: "uploaded",
  };
}

const GENERATED_TOOL_LABEL: Record<string, string> = {
  crop_image: "Cropped image",
  generate_image: "Generated image",
  merge_videos: "Merged video",
};

type GeneratedToolInvocationRow = {
  id: string;
  chatId: string;
  nodeType: string;
  resultUrls: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Projects one COMPLETED ToolInvocation's `resultUrls` into media-library
 * items — never persisted, computed at read time only (see
 * AttachmentSourceSchema's doc comment in contracts/attachments.ts). One
 * DTO per URL since `generate_image`'s `n` can produce several from a
 * single invocation.
 */
function toGeneratedDTOs(row: GeneratedToolInvocationRow): AttachmentDTO[] {
  const urls = Array.isArray(row.resultUrls) ? row.resultUrls.filter((u): u is string => typeof u === "string") : [];
  return urls.map((url, index) => ({
    id: `${row.id}:${index}`,
    chatId: row.chatId,
    messageId: null,
    orderIndex: index,
    status: "READY" as const,
    mimeType: null,
    byteSize: null,
    fileName: GENERATED_TOOL_LABEL[row.nodeType] ?? row.nodeType,
    resultUrl: url,
    errorCode: null,
    errorMessage: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: "generated" as const,
  }));
}

export class AttachmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentLimitError";
  }
}

/**
 * Community-plan 5GB/month accounting (assignment §5 "Limits ... Transloadit
 * Community-plan limits"). A running byte-sum aggregate over this owner's
 * rows created in the current UTC calendar month — not a Transloadit
 * Billing API call, since `billing:read` isn't a scope granted on the
 * current Auth Key (open-questions.md "S4/asset gaps with no current
 * owner"). One indexed aggregate query, cheap at this scale.
 */
async function monthlyUploadedBytes(ownerId: string, tx: Prisma.TransactionClient | typeof prisma = prisma): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const result = await tx.attachment.aggregate({
    // CANCELLED uploads stored nothing — they must not permanently count
    // against the monthly cap, same as FAILED ones.
    where: { ownerId, createdAt: { gte: monthStart }, status: { notIn: ["FAILED", "CANCELLED"] } },
    _sum: { byteSize: true },
  });
  return result._sum.byteSize ?? 0;
}

export interface RequestedUploadFile {
  fileName: string;
  mimeType: string;
  byteSize: number;
}

export interface MintedUpload {
  attachmentId: string;
  params: string;
  signature: string;
}

/**
 * Validates the batch against app-level limits (count, per-file size,
 * monthly quota — assignment: "Reject before persistence with specific,
 * user-safe validation feedback"), then creates one PENDING Attachment row
 * per file and mints that file's own signed upload params. Rejects the
 * whole batch, writing nothing, on any violation — never a partial
 * create-then-fail.
 */
export async function requestUploadParams(params: {
  chatId?: string;
  ownerId: string;
  files: RequestedUploadFile[];
}): Promise<MintedUpload[]> {
  const { chatId = null, ownerId, files } = params;

  const oversized = files.find((f) => f.byteSize > MAX_ATTACHMENT_BYTES);
  if (oversized) {
    throw new AttachmentLimitError(`"${oversized.fileName}" exceeds the 0.5GB per-file limit.`);
  }
  const batchBytes = files.reduce((sum, f) => sum + f.byteSize, 0);

  // Quota/count reads and the writes that depend on them must be one
  // Serializable transaction — otherwise two concurrent batches can each
  // read a passing snapshot and both commit, blowing past the limits.
  return prisma.$transaction(
    async (tx) => {
      const usedBytes = await monthlyUploadedBytes(ownerId, tx);
      if (usedBytes + batchBytes > MAX_MONTHLY_UPLOAD_BYTES) {
        throw new AttachmentLimitError(
          "This upload would exceed the monthly upload allowance. Remove a few files or upload smaller ones.",
        );
      }

      // ownerId scopes this even when chatId is still null (pre-send draft) —
      // chatId alone can't disambiguate users at that point.
      const existingCount = await tx.attachment.count({
        where: { ownerId, chatId, messageId: null, status: { in: ["PENDING", "READY"] } },
      });
      if (existingCount + files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new AttachmentLimitError(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments are allowed per message.`);
      }

      const created: MintedUpload[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const row = await tx.attachment.create({
          data: {
            chatId,
            ownerId,
            orderIndex: existingCount + i,
            status: "PENDING",
            mimeType: file.mimeType,
            byteSize: file.byteSize,
            fileName: file.fileName,
          },
        });
        const signed = signUploadAssemblyParams({ ownerId, attachmentId: row.id });
        created.push({ attachmentId: row.id, params: signed.params, signature: signed.signature });
      }
      return created;
    },
    { isolationLevel: "Serializable" },
  );
}

export class AttachmentNotFoundError extends Error {
  constructor() {
    super("Attachment not found.");
    this.name = "AttachmentNotFoundError";
  }
}

/**
 * Server-verified completion (S4 implementation plan §4: "the backend
 * fetches the Assembly status from Transloadit itself and trusts only its
 * own fetch — never a client-supplied result URL"). Idempotent: a second
 * call against an already-READY/FAILED row is a no-op returning the
 * existing DTO, never a duplicate write or a second state transition
 * (assignment: "Handle ... duplicate completion").
 */
export async function completeAttachment(params: {
  ownerId: string;
  attachmentId: string;
  assemblyId: string;
}): Promise<AttachmentDTO> {
  const { ownerId, attachmentId, assemblyId } = params;

  const existing = await prisma.attachment.findFirst({ where: { id: attachmentId, ownerId } });
  if (!existing) throw new AttachmentNotFoundError();
  if (existing.status !== "PENDING") return toAttachmentDTO(existing);

  // Global status-retrieval endpoint — documented, not region-specific
  // (Context7 /llmstxt/transloadit_llms-full_txt, "GET /assemblies/{ASSEMBLY_ID}",
  // base https://api2.transloadit.com per the same doc's POST /assemblies example).
  const statusUrl = `${TRANSLOADIT_API_BASE_URL}/assemblies/${assemblyId}`;
  try {
    const result = await awaitAssembly(statusUrl);
    if (!result.ok || !result.resultUrl) {
      await prisma.attachment.updateMany({
        where: { id: attachmentId, status: "PENDING" },
        data: { status: "FAILED", assemblyId, errorCode: "ASSEMBLY_FAILED", errorMessage: "Upload could not be processed. Please try again." },
      });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      return toAttachmentDTO(row);
    }

    // The completed Assembly must actually be this attachment's own upload —
    // never accept a resultUrl from an Assembly that belongs to a different
    // attachment/owner or was created against a different Template.
    if (
      result.templateId !== TRANSLOADIT_UPLOAD_TEMPLATE_ID ||
      result.fields?.attachmentId !== attachmentId ||
      result.fields?.ownerId !== ownerId
    ) {
      await prisma.attachment.updateMany({
        where: { id: attachmentId, status: "PENDING" },
        data: { status: "FAILED", assemblyId, errorCode: "ASSEMBLY_MISMATCH", errorMessage: "Upload could not be verified. Please try again." },
      });
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      return toAttachmentDTO(row);
    }

    const updated = await prisma.attachment.updateMany({
      where: { id: attachmentId, status: "PENDING" },
      data: {
        status: "READY",
        assemblyId,
        resultUrl: result.resultUrl,
        // Trust Transloadit's own reported byte count over the client's
        // originally-declared byteSize — a malicious client could otherwise
        // under-report size to dodge the monthly quota.
        ...(result.bytesReceived !== null ? { byteSize: result.bytesReceived } : {}),
      },
    });
    // Lost the race to a concurrent duplicate-completion call — read back
    // whatever the winner wrote rather than treating this as an error
    // (idempotent duplicate completion).
    if (updated.count === 0) {
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      return toAttachmentDTO(row);
    }
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    return toAttachmentDTO(row);
  } catch (error) {
    // Never surface the raw Transloadit error string (mirrors
    // ToolInvocation.errorMessage's existing rule) — covers both a
    // TransloaditTimeoutError (temporary-result expiry / a genuinely stuck
    // Assembly) and a TransloaditRequestError (interrupted upload / failed
    // Assembly creation), the assignment's explicit failure list.
    const errorCode = error instanceof TransloaditTimeoutError ? "ASSEMBLY_TIMEOUT" : error instanceof TransloaditRequestError ? "ASSEMBLY_REQUEST_FAILED" : "UNKNOWN";
    await prisma.attachment.updateMany({
      where: { id: attachmentId, status: "PENDING" },
      data: {
        status: "FAILED",
        assemblyId,
        errorCode,
        errorMessage: "Upload could not be completed. Please try again.",
      },
    });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    return toAttachmentDTO(row);
  }
}

/** Cancel mid-upload — only a still-unbound PENDING row can be cancelled. */
export async function cancelAttachment(ownerId: string, attachmentId: string): Promise<AttachmentDTO | null> {
  const updated = await prisma.attachment.updateMany({
    where: { id: attachmentId, ownerId, messageId: null, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (updated.count === 0) return null;
  const row = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
  return toAttachmentDTO(row);
}

/**
 * Permanently remove a media-library entry (READY/FAILED/CANCELLED, never
 * PENDING — that's cancelAttachment's job) — never a row already bound to a
 * sent message, since that would corrupt chat history.
 */
export async function deleteAttachment(ownerId: string, attachmentId: string): Promise<AttachmentDTO | null> {
  const row = await prisma.attachment.findFirst({ where: { id: attachmentId, ownerId, messageId: null } });
  if (!row) return null;
  await prisma.attachment.delete({ where: { id: attachmentId } });
  return toAttachmentDTO(row);
}

export interface ListAttachmentsParams {
  ownerId: string;
  chatId?: string;
  unbound?: boolean;
  source?: "all" | "uploaded" | "generated";
  limit: number;
  cursor: { createdAt: string; id: string } | null;
}

function cursorFilter(cursor: { createdAt: string; id: string } | null | undefined): Prisma.AttachmentWhereInput["OR"] {
  if (!cursor) return undefined;
  return [
    { createdAt: { lt: new Date(cursor.createdAt) } },
    { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
  ];
}

type LibraryCursorPart = { createdAt: string; id: string };
type LibraryCursorPayload = { u?: LibraryCursorPart; g?: LibraryCursorPart };

function isCursorPart(v: unknown): v is LibraryCursorPart {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).createdAt === "string" && typeof (v as Record<string, unknown>).id === "string";
}

/**
 * The library page merges two independently-paginated streams — real
 * Attachment rows and synthetic generated-tool-result DTOs — that don't
 * share one id namespace, so a single flat {createdAt,id} cursor can't
 * safely resume both (a bare ToolInvocation id vs. its own composite
 * "id:urlIndex" continuation sort against each other unpredictably). This
 * packs one position per stream into the `id` slot of the flat envelope the
 * shared lib/cursor.ts codec already carries end-to-end on the wire, so
 * route.ts's existing encode/decode calls stay untouched — they just see an
 * opaque id string.
 */
function encodeLibraryCursor(payload: LibraryCursorPayload): LibraryCursorPart {
  const createdAt = payload.u?.createdAt ?? payload.g?.createdAt ?? new Date(0).toISOString();
  return { createdAt, id: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url") };
}

/**
 * Decodes the packed per-stream payload. Falls back to treating an
 * old-style flat {createdAt,id} cursor (a client that fetched a page before
 * this fix shipped) as "both streams resume from this position", so an
 * in-flight pre-deploy cursor doesn't 400.
 */
function decodeLibraryCursor(cursor: LibraryCursorPart | null | undefined): LibraryCursorPayload | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor.id, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const u = isCursorPart(obj.u) ? obj.u : undefined;
      const g = isCursorPart(obj.g) ? obj.g : undefined;
      if (u || g) return { u, g };
    }
  } catch {
    // Not our packed payload — fall through to legacy handling.
  }
  return { u: cursor, g: cursor };
}

/**
 * `unbound=true` is the media library: every owned READY upload (bound or
 * not — an already-sent attachment still belongs in "all the uploaded
 * media"), merged with every owned COMPLETED tool result, optionally
 * narrowed by `source`. Two heterogeneous row sets can't share one SQL
 * ORDER BY, so each is independently cursor-filtered (own id namespace, own
 * cursor position — see decodeLibraryCursor) and over-fetched by `limit`,
 * then merge-sorted by (createdAt, id) in application code — safe at this
 * project's data volume (see the header comment on toGeneratedDTOs). A page
 * never splits one ToolInvocation's generated URLs across two pages: the
 * generated side accumulates whole groups until it reaches `limit`,
 * accepting up to 3 extra items of overshoot from the group that crosses
 * the boundary (generate_image's `n` is capped at 4) — `hasMore` is derived
 * per-source from each side's own over-fetch, not from the merged array's
 * length, which is not a reliable signal once url fan-out is in play.
 * Outside library mode this is unchanged: a single chat's bound rows for
 * that chat's send-time picker.
 */
export async function listAttachments(params: ListAttachmentsParams) {
  const { ownerId, chatId, unbound, source = "all", limit, cursor } = params;

  if (!unbound) {
    const where: Prisma.AttachmentWhereInput = {
      ownerId,
      ...(chatId ? { chatId } : {}),
      ...(cursor ? { OR: cursorFilter(cursor) } : {}),
    };
    const rows = await prisma.attachment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { items: page.map(toAttachmentDTO), hasMore, lastCreatedAt: last?.createdAt.toISOString(), lastId: last?.id };
  }

  const wantUploaded = source === "all" || source === "uploaded";
  const wantGenerated = source === "all" || source === "generated";
  const cursorPayload = decodeLibraryCursor(cursor);

  const [attachmentRows, invocationRows] = await Promise.all([
    wantUploaded
      ? prisma.attachment.findMany({
          where: { ownerId, status: "READY", ...(cursorPayload?.u ? { OR: cursorFilter(cursorPayload.u) } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        })
      : Promise.resolve([]),
    wantGenerated
      ? prisma.toolInvocation.findMany({
          where: {
            agentRun: { chat: { ownerId } },
            status: "COMPLETED",
            ...(cursorPayload?.g ? { OR: cursorFilter(cursorPayload.g) as Prisma.ToolInvocationWhereInput["OR"] } : {}),
          },
          select: { id: true, nodeType: true, resultUrls: true, createdAt: true, updatedAt: true, agentRun: { select: { chatId: true } } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        })
      : Promise.resolve([]),
  ]);

  const hasMoreUploaded = wantUploaded && attachmentRows.length > limit;
  const uploadedPage = hasMoreUploaded ? attachmentRows.slice(0, limit) : attachmentRows;
  const uploadedLast = uploadedPage[uploadedPage.length - 1];

  // Consume whole ToolInvocation groups — never split one mid-page — until
  // the accumulated item count reaches `limit`.
  const generatedItems: AttachmentDTO[] = [];
  let lastConsumedInvocation: (typeof invocationRows)[number] | undefined;
  let consumedInvocationCount = 0;
  for (const row of invocationRows) {
    generatedItems.push(
      ...toGeneratedDTOs({ id: row.id, chatId: row.agentRun.chatId, nodeType: row.nodeType, resultUrls: row.resultUrls, createdAt: row.createdAt, updatedAt: row.updatedAt }),
    );
    lastConsumedInvocation = row;
    consumedInvocationCount++;
    if (generatedItems.length >= limit) break;
  }
  // A fetched-but-unconsumed row (possible only because of the `limit + 1`
  // over-fetch) is proof more generated data exists beyond this page.
  const hasMoreGenerated = wantGenerated && consumedInvocationCount < invocationRows.length;

  const merged = [...uploadedPage.map(toAttachmentDTO), ...generatedItems].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const hasMore = hasMoreUploaded || hasMoreGenerated;
  const nextU: LibraryCursorPart | undefined = wantUploaded
    ? uploadedLast
      ? { createdAt: uploadedLast.createdAt.toISOString(), id: uploadedLast.id }
      : cursorPayload?.u
    : cursorPayload?.u;
  const nextG: LibraryCursorPart | undefined = wantGenerated
    ? lastConsumedInvocation
      ? { createdAt: lastConsumedInvocation.createdAt.toISOString(), id: lastConsumedInvocation.id }
      : cursorPayload?.g
    : cursorPayload?.g;

  const envelope = encodeLibraryCursor({ u: nextU, g: nextG });
  return { items: merged, hasMore, lastCreatedAt: envelope.createdAt, lastId: envelope.id };
}

export class AttachmentBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentBindError";
  }
}

/**
 * Binds a set of owned, READY, currently-unbound attachments to a message,
 * preserving the client's requested order via orderIndex — called inside
 * createTurn's transaction (send-turn.ts) so message-create and attachment-
 * bind land atomically, per 00-master-spec.md §6's transaction rule.
 * Throws (never silently drops) if any id doesn't resolve to an eligible
 * row — a stale/foreign/already-bound id is a client bug, not something to
 * paper over.
 */
export async function bindAttachmentsToMessage(
  tx: Prisma.TransactionClient,
  params: { ownerId: string; chatId: string; messageId: string; attachmentIds: string[] },
): Promise<void> {
  const { ownerId, chatId, messageId, attachmentIds } = params;
  if (attachmentIds.length === 0) return;

  // A row is eligible if it's already scoped to this chat (media-library
  // pick made after the chat existed) OR still chatless (uploaded from the
  // empty-state composer before this chat was created) — either way, send
  // is what finally pins chatId, never the upload step.
  // updateMany re-checks the full ownership/unbound/READY predicate at write
  // time (not just at an earlier read) and asserts exactly one row matched —
  // otherwise two concurrent sends could both read the same unbound
  // attachment as eligible and both successfully bind it.
  for (let i = 0; i < attachmentIds.length; i++) {
    const id = attachmentIds[i];
    const updated = await tx.attachment.updateMany({
      where: {
        id,
        ownerId,
        OR: [{ chatId }, { chatId: null }],
        messageId: null,
        status: "READY",
      },
      data: { messageId, orderIndex: i, chatId },
    });
    if (updated.count !== 1) {
      throw new AttachmentBindError("One or more attachments are unavailable.");
    }
  }
}
