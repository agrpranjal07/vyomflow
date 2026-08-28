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
    // 2026-08-29: round-level payload — a CREDIT_APPROVAL waitpoint may
    // gate more than one call in the same round; approval stays
    // all-or-nothing (resolvedPayload is still just { approved, respondedAt }).
    requestPayload: {
      calls: [{ toolCallId: "call_1", toolName: "gpt_image_2", estimatedCredits: 0.1 }],
      estimatedCredits: 0.1,
      threshold: 0.08,
    },
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
    expect(screen.getByText(/gpt_image_2 — ~0\.1M credits/)).toBeInTheDocument();
    expect(screen.getByText(/will use ~0\.1M credits/)).toBeInTheDocument();
    expect(screen.getByText(/threshold 0\.08M/)).toBeInTheDocument();
  });

  it("lists every call in a multi-call round and shows the round total, not just the first call", () => {
    render(
      <ApprovalOverlay
        waitpoint={creditApprovalWaitpoint({
          requestPayload: {
            calls: [
              { toolCallId: "call_1", toolName: "generate_image", estimatedCredits: 0.1 },
              { toolCallId: "call_2", toolName: "generate_image", estimatedCredits: 0.1 },
              { toolCallId: "call_3", toolName: "generate_image", estimatedCredits: 0.1 },
            ],
            estimatedCredits: 0.3,
            threshold: 0.08,
          },
        })}
        onRespond={vi.fn()}
      />,
    );
    // Round total, not any single call's estimate.
    expect(screen.getByText(/0\.3M credits/)).toBeInTheDocument();
    // Every call renders, not just the first — this is the whole point of
    // hoisting approval to one round-level waitpoint (2026-08-29 fix): three
    // over-threshold calls in one round must produce ONE prompt listing all
    // three, not three separate prompts.
    expect(screen.getAllByText(/generate_image — ~0\.1M credits/)).toHaveLength(3);
    // Still a single Decline/Approve pair — all-or-nothing per round, not
    // per-call granularity.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Decline" })).toHaveLength(1);
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

  it("boundary — re-passing the SAME still-PENDING waitpoint after it was already answered renders it fully interactive again (this component has no memory of its own; suppressing a stale re-appearance of the same id is the caller's job — see use-active-run.test.tsx's resolvedWaitpointIds coverage)", async () => {
    const onRespond = vi.fn().mockResolvedValue({ status: "COMPLETED" });
    const user = userEvent.setup();
    const wp = creditApprovalWaitpoint();
    const { rerender } = render(<ApprovalOverlay key={wp.id} waitpoint={wp} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onRespond).toHaveBeenCalledTimes(1);

    // Same id, still PENDING (a caller that failed to filter this out —
    // exactly the stale-REST-snapshot race use-active-run.ts's
    // `applyWaitpoint`/`resolvedWaitpointIds` guard exists to prevent).
    // ApprovalOverlay itself does not — and must not — remember that this
    // id was already answered; it renders whatever PENDING waitpoint it's
    // handed. This is a boundary test, not a bug report: it documents that
    // the suppression responsibility lives entirely upstream.
    rerender(<ApprovalOverlay key={wp.id} waitpoint={wp} onRespond={onRespond} />);
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });
});
