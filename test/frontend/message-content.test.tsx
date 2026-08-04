import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageContent } from "@/components/chat/message-content";

describe("MessageContent — markdown link/image upgrade to real media (F6)", () => {
  it("renders a markdown link whose href is an image URL as real media, not a bare link", () => {
    const { container } = render(
      <MessageContent blocks={[{ type: "text", text: "Here's the poster: [View the poster](https://x/out.png)" }]} />,
    );
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view the poster/i })).not.toBeInTheDocument();
  });

  it("renders a markdown link whose href is a video URL as a real <video>", () => {
    const { container } = render(
      <MessageContent blocks={[{ type: "text", text: "[merged result](https://x/out.mp4)" }]} />,
    );
    expect(container.querySelector("video")).toBeInTheDocument();
  });

  it("leaves an ordinary (non-asset) link as a normal anchor", () => {
    render(<MessageContent blocks={[{ type: "text", text: "[see docs](https://example.com/article)" }]} />);
    const link = screen.getByRole("link", { name: /see docs/i });
    expect(link).toHaveAttribute("href", "https://example.com/article");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders a genuine markdown image (![]()) through GeneratedAsset instead of a raw unstyled <img>", () => {
    const { container } = render(<MessageContent blocks={[{ type: "text", text: "![poster](https://x/out.png)" }]} />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveClass("max-h-80");
  });

  it("renders an extensionless resultUrl referenced as a markdown link as real media, using the sibling tool_result", () => {
    const url = "https://cdn.example.com/assets/abc123";
    const { container } = render(
      <MessageContent
        blocks={[
          { type: "tool_use", id: "call_1", name: "crop_image", input: { image_url: "https://x/a.png" } },
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            toolInvocationId: "inv_1",
            name: "crop_image",
            status: "COMPLETED",
            resultUrls: [url],
          },
          { type: "text", text: `[caption](${url})` },
        ]}
      />,
    );
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /caption/i })).not.toBeInTheDocument();
  });

  it("leaves a link not in resultUrls with an unrecognized extension as a normal anchor", () => {
    render(
      <MessageContent
        blocks={[
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            status: "COMPLETED",
            resultUrls: ["https://cdn.example.com/assets/other-known-asset"],
          },
          { type: "text", text: "[see docs](https://example.com/unrelated-page)" },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /see docs/i });
    expect(link).toHaveAttribute("href", "https://example.com/unrelated-page");
  });
});

describe("MessageContent — full content-block coverage without losing ordering (assignment §5)", () => {
  it("renders a reasoning block as a collapsible 'Reasoned' step", () => {
    render(
      <MessageContent
        blocks={[
          { type: "reasoning", text: "I'll crop the image to a square." },
          { type: "text", text: "Done." },
        ]}
      />,
    );
    expect(screen.getByText("Reasoned")).toBeInTheDocument();
  });

  it("renders a citation block as a link", () => {
    render(
      <MessageContent blocks={[{ type: "citation", url: "https://example.com/source", title: "Source article" }]} />,
    );
    const link = screen.getByRole("link", { name: /source article/i });
    expect(link).toHaveAttribute("href", "https://example.com/source");
  });

  it("renders the per-message credits line once a trailing usage block is present, summing tool + LLM credits", () => {
    render(
      <MessageContent
        blocks={[
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            status: "COMPLETED",
            creditUsed: 0.15,
          },
          { type: "text", text: "Done." },
          { type: "usage", promptTokens: 10, completionTokens: 5, costCredits: 0.06 },
        ]}
      />,
    );
    expect(screen.getByText(/0\.21M credits/)).toBeInTheDocument();
  });

  it("does not render a credits line when no usage block is present (a live/unsettled message)", () => {
    render(<MessageContent blocks={[{ type: "text", text: "Still going" }]} />);
    expect(screen.queryByText(/credits/i)).not.toBeInTheDocument();
  });

  it("groups consecutive reasoning + tool blocks under one 'Completed N steps' header, preserving array order relative to surrounding text", () => {
    render(
      <MessageContent
        blocks={[
          { type: "text", text: "Intro text." },
          { type: "reasoning", text: "I'll crop it." },
          { type: "tool_use", id: "call_1", name: "crop_image", input: {} },
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            status: "COMPLETED",
            name: "crop_image",
          },
          { type: "text", text: "All done." },
        ]}
      />,
    );
    // One group covering the reasoning step + the tool_use/tool_result pair == 2 steps (reasoning + tool call).
    expect(screen.getByText("Completed 2 steps")).toBeInTheDocument();
    expect(screen.getByText("Intro text.")).toBeInTheDocument();
    expect(screen.getByText("All done.")).toBeInTheDocument();
  });

  it("reads 'Completed 1 step' (singular) for a single-tool turn, matching the reference's own short-turn copy", () => {
    render(
      <MessageContent
        blocks={[
          { type: "tool_use", id: "call_1", name: "crop_image", input: {} },
          { type: "tool_result", toolUseId: "call_1", output: {}, status: "COMPLETED", name: "crop_image" },
          { type: "text", text: "Cropped." },
        ]}
      />,
    );
    expect(screen.getByText("Completed 1 step")).toBeInTheDocument();
  });

  it("shows 'Working · N steps' while a tool in the group is still running", () => {
    render(
      <MessageContent
        blocks={[
          { type: "tool_use", id: "call_1", name: "crop_image", input: {} },
          { type: "tool_result", toolUseId: "call_1", output: {}, status: "RUNNING", name: "crop_image" },
        ]}
      />,
    );
    expect(screen.getByText("Working · 1 step")).toBeInTheDocument();
  });
});
