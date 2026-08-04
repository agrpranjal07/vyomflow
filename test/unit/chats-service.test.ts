import { describe, it, expect } from "vitest";
import { deriveTitleFromContent } from "@/services/chats";

describe("deriveTitleFromContent", () => {
  it("collapses internal whitespace/newlines and trims", () => {
    expect(deriveTitleFromContent([{ type: "text", text: "  write a poem\nabout   the ocean  " }])).toBe(
      "write a poem about the ocean",
    );
  });

  it("truncates long text to 60 chars with a trailing ellipsis", () => {
    const long = "a".repeat(120);
    const title = deriveTitleFromContent([{ type: "text", text: long }]);
    expect(title).not.toBeNull();
    expect(title!.length).toBe(61);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("does not truncate text at or under the limit", () => {
    const exact = "a".repeat(60);
    expect(deriveTitleFromContent([{ type: "text", text: exact }])).toBe(exact);
  });

  it("joins multiple text blocks with a space", () => {
    expect(
      deriveTitleFromContent([
        { type: "text", text: "hello" },
        { type: "tool_use", text: undefined },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("returns null for content with no usable text", () => {
    expect(deriveTitleFromContent([{ type: "tool_use" }])).toBeNull();
    expect(deriveTitleFromContent([{ type: "text", text: "   " }])).toBeNull();
    expect(deriveTitleFromContent([])).toBeNull();
  });
});
