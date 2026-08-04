/**
 * Assembles the OpenRouter message array from a chat's persisted history
 * (the orchestrator's "restore session context" step — assignment's Turn
 * Lifecycle / 00-master-spec.md §8). S1/S2 only ever write `text` blocks;
 * S3 assistant messages may additionally carry `tool_use`/`tool_result`
 * blocks (a prior turn that called a tool) — those expand into the
 * assistant `tool_calls` + one `tool` role message per call that the
 * OpenAI-compatible wire format requires, so a later turn's model call can
 * "see" (and potentially chain off) an earlier turn's tool results
 * (assignment §6: "may chain them, such as generating an image and then
 * cropping it").
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ContentBlockSchema, type ContentBlock } from "@/contracts/common";
import type { OpenRouterMessage, OpenRouterContentPart, OpenRouterToolCall } from "@/server/openrouter/client";
import { MAX_CONVERSATION_HISTORY_MESSAGES } from "@/lib/config";
import { MAX_IMAGE_PARTS_PER_MESSAGE, MAX_IMAGE_PARTS_PER_REQUEST } from "@/contracts/attachments";

const ContentBlockArraySchema = z.array(ContentBlockSchema);

/**
 * `Message.content` is a Prisma `Json` column — write-path validation
 * (Zod, at the API boundary) is the normal guard, but this read path must
 * not assume every row still matches that shape (a hand-edited row, a
 * future migration, a bug elsewhere) — malformed content must degrade to
 * an empty turn contribution, never crash the whole turn (hardening pass).
 */
function parseBlocks(content: unknown): ContentBlock[] {
  const parsed = ContentBlockArraySchema.safeParse(content);
  return parsed.success ? parsed.data : [];
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * S4: image attachments are additionally sent as real `image_url` content
 * parts (see rowToMessages), but that path is capped and covers images
 * only — this compact text enumeration is what makes *every* attached
 * file's URL visible to the model regardless of type or cap.
 * This is how the model learns a URL exists to pass into
 * crop_image.image_url / gpt_image_2.images / merge_videos.video_urls —
 * without it, tool calls can never reference a user's uploaded file.
 */
function formatAttachmentsLine(attachments: { resultUrl: string | null; fileName: string | null; mimeType: string | null }[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments
    .filter((a) => a.resultUrl)
    .map((a, i) => `${i + 1}. ${a.resultUrl} (${a.mimeType ?? "unknown type"}${a.fileName ? `, ${a.fileName}` : ""})`);
  if (lines.length === 0) return "";
  return `[Attached file URLs — reuse these exact URLs only when calling a tool to edit them:\n${lines.join("\n")}]`;
}

/**
 * Expands one row's blocks into 1+ OpenRouter messages. A plain user/
 * system row, or an assistant row with no tool blocks, becomes exactly one
 * message. An assistant row that used tools becomes: one assistant message
 * (joined text + every `tool_use` block as a `tool_calls` entry) followed
 * by one `tool` role message per `tool_use`, matched to its `tool_result`
 * by `toolUseId`. A `tool_use` with no matching `tool_result` (a turn that
 * crashed/was cancelled mid-tool) is dropped rather than sent with no
 * paired tool message, which OpenAI-compatible providers reject.
 */
function rowToMessages(
  role: "user" | "assistant" | "system",
  blocks: ContentBlock[],
  attachments: { resultUrl: string | null; fileName: string | null; mimeType: string | null }[] = [],
  imageBudget?: { remaining: number },
): OpenRouterMessage[] {
  const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
  if (role !== "assistant" || toolUses.length === 0) {
    const text = blocksToText(blocks);
    const attachmentsLine = role === "user" ? formatAttachmentsLine(attachments) : "";
    const content = [text, attachmentsLine].filter((s) => s.length > 0).join("\n\n");

    const imageAttachments = attachments.filter(
      (a): a is { resultUrl: string; fileName: string | null; mimeType: string | null } =>
        !!a.resultUrl && !!a.mimeType && a.mimeType.startsWith("image/"),
    );
    if (role !== "user" || imageAttachments.length === 0) {
      return [{ role, content }];
    }

    // Cap vision parts per-message and across the whole request; images
    // past either cap still appear in the text line above, so tool-call
    // chaining (crop_image, etc.) is unaffected — only the vision preview
    // is capped.
    const parts: OpenRouterContentPart[] = [];
    if (content.length > 0) parts.push({ type: "text", text: content });
    const budget = imageBudget ?? { remaining: MAX_IMAGE_PARTS_PER_REQUEST };
    let perMessage = 0;
    for (const attachment of imageAttachments) {
      if (perMessage >= MAX_IMAGE_PARTS_PER_MESSAGE || budget.remaining <= 0) break;
      parts.push({ type: "image_url", image_url: { url: attachment.resultUrl } });
      perMessage += 1;
      budget.remaining -= 1;
    }
    return [{ role, content: parts }];
  }

  const resultsByUseId = new Map(
    blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
      .map((b) => [b.toolUseId, b]),
  );
  const pairedUses = toolUses.filter((use) => resultsByUseId.has(use.id));
  if (pairedUses.length === 0) {
    return [{ role, content: blocksToText(blocks) }];
  }

  const toolCalls: OpenRouterToolCall[] = pairedUses.map((use) => ({
    id: use.id,
    type: "function",
    function: { name: use.name, arguments: JSON.stringify(use.input) },
  }));
  const text = blocksToText(blocks);
  const messages: OpenRouterMessage[] = [{ role: "assistant", content: text.length > 0 ? text : null, tool_calls: toolCalls }];
  for (const use of pairedUses) {
    const result = resultsByUseId.get(use.id)!;
    messages.push({ role: "tool", tool_call_id: use.id, content: JSON.stringify(result.output) });
  }
  return messages;
}

/**
 * Chronological (oldest-first) messages up to and including
 * `uptoMessageId`, capped to `MAX_CONVERSATION_HISTORY_MESSAGES` most-recent
 * rows in that window (hardening pass — previously unbounded, sending the
 * chat's entire history to OpenRouter on every turn regardless of length).
 */
export async function buildConversationMessages(chatId: string, uptoMessageId: string): Promise<OpenRouterMessage[]> {
  const uptoMessage = await prisma.message.findUniqueOrThrow({ where: { id: uptoMessageId } });

  const rows = await prisma.message.findMany({
    where: {
      chatId,
      OR: [
        { createdAt: { lt: uptoMessage.createdAt } },
        { createdAt: uptoMessage.createdAt, id: { lte: uptoMessage.id } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_CONVERSATION_HISTORY_MESSAGES,
    include: { attachments: { where: { status: "READY" }, orderBy: { orderIndex: "asc" } } },
  });
  rows.reverse(); // back to chronological (oldest-first)

  // Shared across every row so the per-request image-part cap applies to
  // the whole built conversation, not just one message.
  const imageBudget = { remaining: MAX_IMAGE_PARTS_PER_REQUEST };
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant" || row.role === "system")
    .flatMap((row) =>
      rowToMessages(row.role as "user" | "assistant" | "system", parseBlocks(row.content), row.attachments, imageBudget),
    );
}
