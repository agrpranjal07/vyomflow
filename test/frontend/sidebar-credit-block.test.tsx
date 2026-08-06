import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarCreditBlock } from "@/components/chat/sidebar";
import { useCredits } from "@/hooks/use-credits";

// S7 audit 2026-08-21 — regression coverage for two bugs found comparing
// the sidebar footer against the live reference (Claude-in-Chrome
// DOM/computed-style measurement, see .claude/evidence/credits.md's
// "Sidebar footer credit block" section):
//   1. The credit block previously rendered regardless of the footer's own
//      expand/collapse ("More"/"Less") state — the reference shows it only
//      when expanded.
//   2. Its layout was a boxed "MONTHLY PLAN" card, not the reference's flat
//      "Available Credits <value>" row.
//
// Rendering the whole Sidebar pulls in Tooltip/ScrollArea/dialog primitives
// that hit the same "not safely renderable in this workspace's RTL
// environment" problem documented in credits-indicator.test.tsx (base-ui's
// useSyncExternalStore against a null React internals dispatcher) — this
// test targets SidebarCreditBlock directly instead, with a minimal harness
// that mirrors sidebar.tsx's real `isSignedIn && footerExpanded &&
// <SidebarCreditBlock />` gate rather than rendering the full component tree.

vi.mock("@/hooks/use-credits", () => ({
  useCredits: vi.fn(),
}));

function mockCredits(available: string) {
  vi.mocked(useCredits).mockReturnValue({
    data: { balance: available, held: "0", available },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useCredits>);
}

function FooterHarness() {
  const [footerExpanded, setFooterExpanded] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setFooterExpanded((v) => !v)}>
        {footerExpanded ? "Less" : "More"}
      </button>
      {footerExpanded && <SidebarCreditBlock />}
    </div>
  );
}

describe("Sidebar credit block — visibility gated on footer expand state", () => {
  it("is absent when the footer is collapsed (\"More\") — the reference shows no credit content here", () => {
    mockCredits("98.49");
    render(<FooterHarness />);

    expect(screen.getByText("More")).toBeInTheDocument();
    expect(screen.queryByText("Available Credits")).not.toBeInTheDocument();
  });

  it("renders the flat Available Credits row once the footer is expanded (\"Less\")", () => {
    mockCredits("98.49");
    render(<FooterHarness />);

    fireEvent.click(screen.getByText("More"));

    expect(screen.getByText("Available Credits")).toBeInTheDocument();
    expect(screen.getByText("98.49M")).toBeInTheDocument();
    // Flat row, not the old boxed "MONTHLY PLAN" card.
    expect(screen.queryByText("MONTHLY PLAN")).not.toBeInTheDocument();
  });

  it("collapses again on a second click, hiding the credit block", () => {
    mockCredits("98.49");
    render(<FooterHarness />);

    fireEvent.click(screen.getByText("More"));
    expect(screen.getByText("Available Credits")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Less"));
    expect(screen.queryByText("Available Credits")).not.toBeInTheDocument();
  });
});

describe("SidebarCreditBlock — loading/error states, no fabricated balance", () => {
  it("shows a skeleton while loading, not a fabricated value", () => {
    vi.mocked(useCredits).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useCredits>);
    render(<SidebarCreditBlock />);

    expect(screen.getByText("Available Credits")).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?M$/)).not.toBeInTheDocument();
  });

  it("renders no value at all on error — never a fabricated 0.00M", () => {
    vi.mocked(useCredits).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useCredits>);
    render(<SidebarCreditBlock />);

    expect(screen.queryByText("0.00M")).not.toBeInTheDocument();
  });
});

describe("SidebarCreditBlock — Add Credits is honest, not a fake purchase flow", () => {
  it("shows an inert 'not available' message on click, no fabricated success", async () => {
    const { toast } = await import("sonner");
    mockCredits("98.49");
    render(<SidebarCreditBlock />);

    fireEvent.click(screen.getByRole("button", { name: /add credits/i }));

    expect(toast.info).toHaveBeenCalledWith("Adding credits isn't available in this build.");
  });
});
