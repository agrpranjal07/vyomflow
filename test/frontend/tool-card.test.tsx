import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCard } from "@/components/chat/tool-card";
import { MessageContent } from "@/components/chat/message-content";

describe("ToolCard", () => {
  it("renders a running tool with a spinner, no duration/credit badge", () => {
    const { container } = render(<ToolCard name="crop_image" status="RUNNING" input={{ image_url: "https://x/a.png" }} />);
    expect(screen.getByText("Image crop")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByText(/M$/)).not.toBeInTheDocument();
  });

  it("renders a completed tool with duration, credit badge, and output asset", () => {
    render(
      <ToolCard
        name="merge_videos"
        status="COMPLETED"
        input={{ video_urls: ["https://x/a.mp4", "https://x/b.mp4"], transition: "none" }}
        durationMs={9600}
        creditUsed={0.05}
        resultUrls={["https://x/out.mp4"]}
      />,
    );
    expect(screen.getByText("Video merge")).toBeInTheDocument();
    expect(screen.getByText("9.6s")).toBeInTheDocument();
    expect(screen.getAllByText("0.05M").length).toBeGreaterThan(0);
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("renders a failed tool with a red error row and no credit badge", () => {
    render(<ToolCard name="merge_videos" status="FAILED" errorMessage="Provide between 2 and 100 video URLs to merge." />);
    expect(screen.getByText(/Provide between 2 and 100 video URLs/)).toBeInTheDocument();
    expect(screen.queryByText("Credits used")).not.toBeInTheDocument();
  });

  it("renders a non-primitive (object/array) input value as JSON, not [object Object]", () => {
    render(<ToolCard name="crop_image" status="RUNNING" input={{ crop: { x: 0, y: 0, width: 10, height: 10 } }} />);
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    expect(screen.getByText(JSON.stringify({ x: 0, y: 0, width: 10, height: 10 }))).toBeInTheDocument();
  });
});

describe("ToolCard — open/closed default state (turnSettled)", () => {
  it("a RUNNING tool card is open by default", () => {
    const { container } = render(<ToolCard name="crop_image" status="RUNNING" />);
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("a COMPLETED tool card with turnSettled=false (or omitted) stays open", () => {
    const { container } = render(<ToolCard name="crop_image" status="COMPLETED" />);
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("a COMPLETED tool card with turnSettled=true is closed", () => {
    const { container } = render(<ToolCard name="crop_image" status="COMPLETED" turnSettled />);
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("manually collapsing a card keeps it closed even after status changes to COMPLETED+turnSettled", () => {
    const { container, rerender } = render(<ToolCard name="crop_image" status="RUNNING" />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details).toHaveAttribute("open");

    // Simulate the user manually collapsing the card via the native toggle event.
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(details).not.toHaveAttribute("open");

    // Status transitions to COMPLETED + turnSettled — manual choice must persist.
    rerender(<ToolCard name="crop_image" status="COMPLETED" turnSettled />);
    expect(details).not.toHaveAttribute("open");
  });

  it("a FAILED card stays open even when turnSettled=true", () => {
    const { container } = render(<ToolCard name="crop_image" status="FAILED" turnSettled />);
    expect(container.querySelector("details")).toHaveAttribute("open");
  });
});

describe("MessageContent — tool block rendering", () => {
  it("renders text and a tool_use/tool_result pair in array order", () => {
    render(
      <MessageContent
        blocks={[
          { type: "text", text: "Cropping " },
          { type: "tool_use", id: "call_1", name: "crop_image", input: { image_url: "https://x/a.png" } },
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: {},
            toolInvocationId: "inv_1",
            name: "crop_image",
            status: "COMPLETED",
            creditUsed: 0.1,
            resultUrls: ["https://x/out.png"],
          },
          { type: "text", text: "done." },
        ]}
      />,
    );
    expect(screen.getByText(/Cropping/)).toBeInTheDocument();
    expect(screen.getByText("Image crop")).toBeInTheDocument();
    expect(screen.getByText(/done\./)).toBeInTheDocument();
  });

  it("renders an orphaned tool_use (no matching tool_result) as a pending card", () => {
    render(
      <MessageContent
        blocks={[{ type: "tool_use", id: "call_2", name: "generate_image", input: { prompt: "a cat" } }]}
      />,
    );
    expect(screen.getByText("AI Generation")).toBeInTheDocument();
  });
});
