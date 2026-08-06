import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalOverlay } from "@/components/chat/approval-overlay";
import type { WaitpointDTO, RespondToWaitpointRequest } from "@/contracts/waitpoints";

function creditApprovalWaitpoint(overrides: Partial<WaitpointDTO> = {}): WaitpointDTO {
  return {
    id: "wp1",
    agentRunId: "run1",
    kind: "CREDIT_APPROVAL",
    status: "PENDING",
    requestPayload: { toolName: "gpt_image_2", estimatedCredits: 0.1, threshold: 0.08 },
    resolvedPayload: null,
    expiresAt: "2026-08-21T21:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  } as WaitpointDTO;
}

function clarificationWaitpoint(overrides: Partial<WaitpointDTO> = {}): WaitpointDTO {
  return {
    id: "wp2",
    agentRunId: "run1",
    kind: "CLARIFICATION",
    status: "PENDING",
    requestPayload: { question: "Which image should I edit?" },
    resolvedPayload: null,
    expiresAt: "2026-08-21T21:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  } as WaitpointDTO;
}

describe("ApprovalOverlay — S6 waitpoint visibility in the UI", () => {
  it("renders nothing when there is no pending waitpoint", () => {
    const { container } = render(<ApprovalOverlay waitpoint={null} onRespond={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the waitpoint is no longer PENDING (resolved/expired)", () => {
    const { container } = render(
      <ApprovalOverlay waitpoint={creditApprovalWaitpoint({ status: "COMPLETED" })} onRespond={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("makes a CREDIT_APPROVAL waitpoint visible with the tool name, estimate, and threshold", () => {
    render(<ApprovalOverlay waitpoint={creditApprovalWaitpoint()} onRespond={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Credit approval requested" })).toBeInTheDocument();
    expect(screen.getByText(/gpt_image_2/)).toBeInTheDocument();
    expect(screen.getByText(/0\.1M credits/)).toBeInTheDocument();
    expect(screen.getByText(/threshold 0\.08M/)).toBeInTheDocument();
  });

  it("Approve sends {kind: CREDIT_APPROVAL, approved: true} for the pending waitpoint's id", async () => {
    const onRespond = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(<ApprovalOverlay waitpoint={creditApprovalWaitpoint()} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onRespond).toHaveBeenCalledWith("wp1", { kind: "CREDIT_APPROVAL", approved: true });
  });

  it("Decline sends {kind: CREDIT_APPROVAL, approved: false}", async () => {
    const onRespond = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(<ApprovalOverlay waitpoint={creditApprovalWaitpoint()} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(onRespond).toHaveBeenCalledWith("wp1", { kind: "CREDIT_APPROVAL", approved: false });
  });

  it("makes a CLARIFICATION waitpoint visible with the model's question", () => {
    render(<ApprovalOverlay waitpoint={clarificationWaitpoint()} onRespond={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Clarification requested" })).toBeInTheDocument();
    expect(screen.getByText("Which image should I edit?")).toBeInTheDocument();
  });

  it("free-text Submit sends {kind: CLARIFICATION, answer} for the pending waitpoint's id", async () => {
    const onRespond = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(<ApprovalOverlay waitpoint={clarificationWaitpoint()} onRespond={onRespond} />);
    await user.type(screen.getByLabelText("Answer"), "The cat photo");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith("wp2", { kind: "CLARIFICATION", answer: "The cat photo" });
  });

  it("renders one button per option instead of free text when the waitpoint offers options", async () => {
    const onRespond = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <ApprovalOverlay
        waitpoint={clarificationWaitpoint({ requestPayload: { question: "Which one?", options: ["A", "B"] } })}
        onRespond={onRespond}
      />,
    );
    expect(screen.queryByLabelText("Answer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onRespond).toHaveBeenCalledWith("wp2", { kind: "CLARIFICATION", answer: "B" });
  });

  it("shows a retry-worthy error and re-enables the buttons when onRespond rejects", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<ApprovalOverlay waitpoint={creditApprovalWaitpoint()} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/couldn't send your response/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });

  it("re-enables the buttons once onRespond resolves, instead of staying permanently disabled", async () => {
    const onRespond = vi.fn().mockResolvedValue({ status: "COMPLETED" });
    const user = userEvent.setup();
    render(<ApprovalOverlay waitpoint={creditApprovalWaitpoint()} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onRespond).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled());
  });

  it("regression — a second, different waitpoint arriving right after the first is answered must not inherit the first's stale answer text or a stuck disabled input (production bug: message-list.tsx's call site never unmounted, so local pending/answer state leaked across waitpoints)", async () => {
    // Mirrors message-list.tsx's real fix: keying ApprovalOverlay on the
    // waitpoint's own id so a genuinely different waitpoint forces a fresh
    // mount instead of reusing stale local state.
    function Harness() {
      const [waitpoint, setWaitpoint] = useState<WaitpointDTO | null>(clarificationWaitpoint());
      const onRespond = async (id: string, body: RespondToWaitpointRequest) => {
        void id;
        void body;
        // Never resolves — simulates the real app's respond() clearing
        // pendingWaitpoint only once the NEXT waitpoint stream part lands,
        // which can arrive before this promise would ever settle.
        setWaitpoint(clarificationWaitpoint({ id: "wp3", requestPayload: { question: "A completely different question?" } }));
        return new Promise<never>(() => {});
      };
      return <ApprovalOverlay key={waitpoint?.id ?? "none"} waitpoint={waitpoint} onRespond={onRespond} />;
    }

    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Answer"), "The cat photo");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // The parent swapped in a brand-new waitpoint (different id/question)
    // before the first submit's promise ever settled — the input must show
    // the NEW question, be empty, and be enabled, not the first waitpoint's
    // stuck-disabled state with its stale answer still in it.
    expect(await screen.findByText("A completely different question?")).toBeInTheDocument();
    const input = screen.getByLabelText("Answer") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).not.toBeDisabled();
  });
});
