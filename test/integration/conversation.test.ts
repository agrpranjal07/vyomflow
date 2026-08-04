import { describe, it, expect } from "vitest";
import { buildConversationMessages } from "@/server/agent/conversation";
import { testDb } from "../support/db";
import { MAX_CONVERSATION_HISTORY_MESSAGES } from "@/lib/config";
import { MAX_IMAGE_PARTS_PER_MESSAGE, MAX_IMAGE_PARTS_PER_REQUEST } from "@/contracts/attachments";
import type { OpenRouterContentPart } from "@/server/openrouter/client";

async function makeChat(clerkUserId: string) {
  const user = await testDb.user.create({ data: { clerkUserId } });
  const chat = await testDb.chat.create({ data: { ownerId: user.id, title: "t" } });
  return chat;
}

async function addMessage(chatId: string, role: "user" | "assistant" | "system", content: unknown) {
  return testDb.message.create({ data: { chatId, role, status: "complete", content } });
}

/** Creates a READY attachment row already bound to `messageId`, at `orderIndex`. */
async function addAttachment(
  ownerId: string,
  chatId: string,
  messageId: string,
  orderIndex: number,
  opts: { mimeType?: string; resultUrl?: string; fileName?: string } = {},
) {
  return testDb.attachment.create({
    data: {
      ownerId,
      chatId,
      messageId,
      orderIndex,
      status: "READY",
      mimeType: opts.mimeType ?? "image/png",
      resultUrl: opts.resultUrl ?? `https://cdn.example.com/img${orderIndex}.png`,
      fileName: opts.fileName ?? `img${orderIndex}.png`,
    },
  });
}

function asParts(content: unknown): OpenRouterContentPart[] {
  expect(Array.isArray(content)).toBe(true);
  return content as OpenRouterContentPart[];
}

describe("buildConversationMessages — malformed content guard (hardening pass)", () => {
  it("a row with malformed (non-array) content degrades to an empty contribution instead of crashing the turn", async () => {
    const chat = await makeChat("user_conv_malformed");
    await addMessage(chat.id, "user", { not: "an array" });
    const last = await addMessage(chat.id, "user", [{ type: "text", text: "hi" }]);

    const messages = await buildConversationMessages(chat.id, last.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe(""); // malformed row degraded, not thrown
    expect(messages[1].content).toBe("hi");
  });

  it("a row with null content degrades to an empty contribution", async () => {
    const chat = await makeChat("user_conv_null");
    await addMessage(chat.id, "user", null as unknown as object);
    const last = await addMessage(chat.id, "user", [{ type: "text", text: "hi" }]);

    const messages = await buildConversationMessages(chat.id, last.id);
    expect(messages[0].content).toBe("");
  });
});

describe("buildConversationMessages — bounded history (hardening pass)", () => {
  it("caps at MAX_CONVERSATION_HISTORY_MESSAGES, keeping the most recent ones in chronological order", async () => {
    const chat = await makeChat("user_conv_bound");
    const total = MAX_CONVERSATION_HISTORY_MESSAGES + 10;
    let last;
    for (let i = 0; i < total; i++) {
      last = await addMessage(chat.id, i % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `m${i}` }]);
    }

    const messages = await buildConversationMessages(chat.id, last!.id);
    expect(messages).toHaveLength(MAX_CONVERSATION_HISTORY_MESSAGES);
    // Most recent MAX_..._MESSAGES messages, oldest-first: the window
    // starts at (total - MAX) and ends at the last message.
    expect(messages[0].content).toBe(`m${total - MAX_CONVERSATION_HISTORY_MESSAGES}`);
    expect(messages[messages.length - 1].content).toBe(`m${total - 1}`);
  });

  // T21 (S7 plan §9.4): a 200-message conversation, including assistant
  // rows that carry a paired tool_use/tool_result — since a row's blocks
  // are atomic (the whole row is either inside or outside the `take` cap,
  // never split mid-row; see conversation.ts's rowToMessages doc comment),
  // the pairing invariant to verify is that every included assistant row
  // with tool_calls is immediately followed by exactly one "tool" role
  // message per call, with no dangling/unpaired tool_calls anywhere in the
  // returned array.
  it("200-message conversation: capped at MAX_CONVERSATION_HISTORY_MESSAGES, oldest-first, tool_use/tool_result pairs remain intact", async () => {
    const chat = await makeChat("user_conv_200");
    const total = 200;
    let last;
    for (let i = 0; i < total; i++) {
      if (i % 10 === 7) {
        // Every 10th-ish row is an assistant turn that called a tool, with
        // both the tool_use and its matching tool_result in the same row
        // (this codebase's actual persisted shape).
        last = await addMessage(chat.id, "assistant", [
          { type: "text", text: `assistant reasoning ${i}` },
          { type: "tool_use", id: `call_${i}`, name: "crop_image", input: { x: 0 } },
          { type: "tool_result", toolUseId: `call_${i}`, output: { ok: true }, isError: false },
        ]);
      } else {
        last = await addMessage(chat.id, i % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `m${i}` }]);
      }
    }

    const messages = await buildConversationMessages(chat.id, last!.id);

    // The underlying row cap is MAX_CONVERSATION_HISTORY_MESSAGES, but each
    // tool-call row expands into 1 (assistant) + N (tool) messages, so the
    // returned array can be longer than the row cap — assert on rows via a
    // proxy (count of distinct assistant "reasoning ###" texts) instead.
    const assistantToolTexts = messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("assistant reasoning "),
    );
    // Rows total - cap gives how many oldest rows were dropped; every
    // surviving tool-call row must have contributed exactly one assistant
    // message (with tool_calls) immediately followed by exactly one "tool"
    // role message — i.e. no unpaired/dangling tool_calls.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls && msg.tool_calls.length > 0) {
        const call = msg.tool_calls[0];
        const next = messages[i + 1];
        expect(next).toBeDefined();
        expect(next.role).toBe("tool");
        expect("tool_call_id" in next ? next.tool_call_id : undefined).toBe(call.id);
      }
    }
    expect(assistantToolTexts.length).toBeGreaterThan(0); // at least one survived the cap
    expect(assistantToolTexts.length).toBeLessThanOrEqual(MAX_CONVERSATION_HISTORY_MESSAGES);

    // Oldest-first: the last message in the window is the most recently created row.
    const lastRowText = typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content : "";
    expect(lastRowText).toContain(String(total - 1));
  });

  it("does not truncate a conversation under the cap", async () => {
    const chat = await makeChat("user_conv_short");
    const last1 = await addMessage(chat.id, "user", [{ type: "text", text: "one" }]);
    const last = await addMessage(chat.id, "assistant", [{ type: "text", text: "two" }]);

    const messages = await buildConversationMessages(chat.id, last.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("one");
    void last1;
  });
});

describe("buildConversationMessages — multimodal image attachments (S4)", () => {
  it("an image attachment produces a content array with a text part + one image_url part", async () => {
    const chat = await makeChat("user_conv_img_basic");
    const msg = await addMessage(chat.id, "user", [{ type: "text", text: "what is this?" }]);
    await addAttachment(chat.ownerId, chat.id, msg.id, 0, { resultUrl: "https://cdn.example.com/a.png" });

    const messages = await buildConversationMessages(chat.id, msg.id);
    expect(messages).toHaveLength(1);
    const parts = asParts(messages[0].content);
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("what is this?") });
    expect(parts[0]).toEqual({ type: "text", text: expect.stringContaining("https://cdn.example.com/a.png") });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } });
  });

  it("a non-image attachment leaves content a plain string, with the URL still in the attachments text line", async () => {
    const chat = await makeChat("user_conv_nonimage");
    const msg = await addMessage(chat.id, "user", [{ type: "text", text: "combine these" }]);
    await addAttachment(chat.ownerId, chat.id, msg.id, 0, {
      mimeType: "video/mp4",
      resultUrl: "https://cdn.example.com/clip.mp4",
      fileName: "clip.mp4",
    });

    const messages = await buildConversationMessages(chat.id, msg.id);
    expect(messages).toHaveLength(1);
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content as string).toContain("https://cdn.example.com/clip.mp4");
  });

  it("mixed image + non-image attachments: only image mimes get vision parts, all urls stay in the text line", async () => {
    const chat = await makeChat("user_conv_mixed");
    const msg = await addMessage(chat.id, "user", [{ type: "text", text: "look at these" }]);
    await addAttachment(chat.ownerId, chat.id, msg.id, 0, { resultUrl: "https://cdn.example.com/img.png" });
    await addAttachment(chat.ownerId, chat.id, msg.id, 1, {
      mimeType: "video/mp4",
      resultUrl: "https://cdn.example.com/vid.mp4",
      fileName: "vid.mp4",
    });

    const messages = await buildConversationMessages(chat.id, msg.id);
    const parts = asParts(messages[0].content);
    const imageParts = parts.filter((p) => p.type === "image_url");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]).toEqual({ type: "image_url", image_url: { url: "https://cdn.example.com/img.png" } });

    const textPart = parts.find((p) => p.type === "text");
    expect(textPart?.text).toContain("https://cdn.example.com/img.png");
    expect(textPart?.text).toContain("https://cdn.example.com/vid.mp4");
  });

  it("an attachment-only send (no text) produces an array with no empty leading text part", async () => {
    const chat = await makeChat("user_conv_attach_only");
    const msg = await addMessage(chat.id, "user", []);
    await addAttachment(chat.ownerId, chat.id, msg.id, 0, { resultUrl: "https://cdn.example.com/only.png" });

    const messages = await buildConversationMessages(chat.id, msg.id);
    const parts = asParts(messages[0].content);
    // No text part at all when there's nothing to say — only the attachments
    // line (non-empty, since an image was attached) plus the image_url part.
    expect(parts.every((p) => p.type !== "text" || p.text.length > 0)).toBe(true);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("more than MAX_IMAGE_PARTS_PER_MESSAGE images in one message: excess get text-line-only, no vision part", async () => {
    const chat = await makeChat("user_conv_permsg_cap");
    const msg = await addMessage(chat.id, "user", [{ type: "text", text: "many images" }]);
    const total = MAX_IMAGE_PARTS_PER_MESSAGE + 2;
    const urls: string[] = [];
    for (let i = 0; i < total; i++) {
      const url = `https://cdn.example.com/m${i}.png`;
      urls.push(url);
      await addAttachment(chat.ownerId, chat.id, msg.id, i, { resultUrl: url });
    }

    const messages = await buildConversationMessages(chat.id, msg.id);
    const parts = asParts(messages[0].content);
    const imageParts = parts.filter((p) => p.type === "image_url");
    expect(imageParts).toHaveLength(MAX_IMAGE_PARTS_PER_MESSAGE);
    // Every url (including the excess) still appears in the text line.
    const textPart = parts.find((p) => p.type === "text")!;
    for (const url of urls) expect(textPart.text).toContain(url);
  });

  it("more than MAX_IMAGE_PARTS_PER_REQUEST images across the whole built history: budget shared, excess text-line-only", async () => {
    const chat = await makeChat("user_conv_reqbudget_cap");
    // Three messages, each under the per-message cap, together exceeding
    // the per-request cap — the budget must be shared across the built
    // array, oldest message consuming it first.
    const perMessage = MAX_IMAGE_PARTS_PER_MESSAGE - 1;
    const numMessages = 3;
    expect(perMessage * numMessages).toBeGreaterThan(MAX_IMAGE_PARTS_PER_REQUEST);

    let last;
    for (let m = 0; m < numMessages; m++) {
      last = await addMessage(chat.id, "user", [{ type: "text", text: `batch ${m}` }]);
      for (let i = 0; i < perMessage; i++) {
        await addAttachment(chat.ownerId, chat.id, last.id, i, { resultUrl: `https://cdn.example.com/${m}-${i}.png` });
      }
    }

    const messages = await buildConversationMessages(chat.id, last!.id);
    expect(messages).toHaveLength(numMessages);
    const totalImageParts = messages.reduce(
      (sum, m) => sum + asParts(m.content).filter((p) => p.type === "image_url").length,
      0,
    );
    expect(totalImageParts).toBe(MAX_IMAGE_PARTS_PER_REQUEST);
    // Every url is still present in its own message's text line, even ones
    // that lost out on a vision part to the shared budget.
    const lastParts = asParts(messages[messages.length - 1].content);
    const lastTextPart = lastParts.find((p) => p.type === "text")!;
    for (let i = 0; i < perMessage; i++) {
      expect(lastTextPart.text).toContain(`https://cdn.example.com/${numMessages - 1}-${i}.png`);
    }
  });

  it("a non-user-role message with attachments-shaped data still returns plain-string content, unchanged", async () => {
    const chat = await makeChat("user_conv_nonuser_role");
    // An assistant row with attachments bound to it is not a shape the
    // product creates today, but conversation.ts's rowToMessages only
    // widens to array content for role === "user" — assert that guard
    // directly by binding an attachment to an assistant-role row.
    const assistantMsg = await addMessage(chat.id, "assistant", [{ type: "text", text: "here you go" }]);
    await addAttachment(chat.ownerId, chat.id, assistantMsg.id, 0, { resultUrl: "https://cdn.example.com/gen.png" });
    const last = await addMessage(chat.id, "user", [{ type: "text", text: "thanks" }]);

    const messages = await buildConversationMessages(chat.id, last.id);
    expect(messages).toHaveLength(2);
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content).toBe("here you go");
  });
});
