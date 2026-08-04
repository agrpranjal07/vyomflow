import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingMessage } from "@/components/chat/streaming-message";
import type { StreamedSegment } from "@/lib/run-status";

describe("StreamingMessage", () => {
  it("renders the accumulated text", () => {
    render(<StreamingMessage text="hello there" />);
    expect(screen.getByText(/hello there/)).toBeInTheDocument();
  });

  it("renders an empty bubble before any text has arrived, with no blinking-cursor artifact (not present in the reference product)", () => {
    const { container } = render(<StreamingMessage text="" />);
    expect(container.querySelector(".streaming-caret")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("never renders reconnect/connection-status text — the reference product shows none (audit §3)", () => {
    render(<StreamingMessage text="partial" />);
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connection lost/i)).not.toBeInTheDocument();
  });

  it("marks the Thinking shell with role=status for screen readers", () => {
    render(<StreamingMessage text="" isThinking />);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });

  it("renders a tool card immediately even with no streamed text yet (F1 — tool-first rounds must not stay hidden behind the Thinking shell)", () => {
    // isThinking is computed by the caller as `!streamedText && !streamedTools?.length` —
    // a tool-first round (streamedTools populated, text still empty) must pass isThinking=false.
    render(
      <StreamingMessage
        text=""
        isThinking={false}
        tools={[{ index: 0, type: "tool", toolInvocationId: "t1", name: "generate_image", status: "DISPATCHING" }]}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("AI Generation")).toBeInTheDocument();
  });

  it("shows each step live as it arrives — a step already rendered stays visible when a later step is appended, instead of the whole group only appearing once the turn settles", () => {
    // Mirrors what use-active-run.ts actually does: `segments` is recomputed
    // from a growing `stream.parts` array on every realtime delivery, and
    // React re-renders StreamingMessage with the new prop — this rerender
    // sequence is that same growth, one step at a time.
    const afterReasoning: StreamedSegment[] = [{ type: "reasoning", text: "I should generate an image for this." }];
    const { rerender } = render(<StreamingMessage text="" isThinking={false} segments={afterReasoning} />);
    expect(screen.getByText("Working · 1 step")).toBeInTheDocument();
    expect(screen.getByText("Reasoned")).toBeInTheDocument();

    const afterToolDispatched: StreamedSegment[] = [
      ...afterReasoning,
      { type: "tool", tool: { index: 1, type: "tool", toolInvocationId: "t1", name: "generate_image", status: "DISPATCHING" } },
    ];
    rerender(<StreamingMessage text="" isThinking={false} segments={afterToolDispatched} />);
    // The reasoning step from the FIRST render is still on screen — it was
    // never hidden or reset while waiting for the tool call to arrive.
    expect(screen.getByText("Reasoned")).toBeInTheDocument();
    expect(screen.getByText("Working · 2 steps")).toBeInTheDocument();
    expect(screen.getByText("AI Generation")).toBeInTheDocument();

    const afterToolCompletedAndText: StreamedSegment[] = [
      afterToolDispatched[0],
      { type: "tool", tool: { index: 1, type: "tool", toolInvocationId: "t1", name: "generate_image", status: "COMPLETED" } },
      { type: "text", text: "Here you go." },
    ];
    rerender(<StreamingMessage text="Here you go." isThinking={false} segments={afterToolCompletedAndText} />);
    // Both earlier steps are still visible alongside the newly-arrived text —
    // nothing already shown gets pulled off screen as later content lands.
    expect(screen.getByText("Reasoned")).toBeInTheDocument();
    expect(screen.getByText("Working · 2 steps")).toBeInTheDocument();
    expect(screen.getByText("Here you go.")).toBeInTheDocument();
  });
});
