import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppHeader } from "@/components/chat/app-header";
import { useCredits } from "@/hooks/use-credits";
import { usePathname } from "next/navigation";

// Fix 1 (credits.md "/usage full dashboard — re-verified": the reference
// never shows the header credits pill on its own /usage page, confirmed
// live). AppHeader hides CreditsIndicator via a usePathname() check.
vi.mock("@/hooks/use-credits", () => ({
  useCredits: vi.fn(),
}));

// components/ui/popover.tsx's @base-ui/react primitives aren't safely
// renderable in this workspace's RTL environment — same problem documented
// in credits-indicator.test.tsx. This test only cares about the pill's
// presence/absence, not popover open state, so a minimal static stand-in
// suffices (no open/close behavior needed here).
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: Record<string, unknown> & { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: () => null,
}));

// ModelSelector renders a base-ui DropdownMenu, same "not safely
// renderable in this workspace's RTL environment" problem — irrelevant to
// this test's concern (pill visibility), so it's stubbed out entirely.
vi.mock("@/components/chat/model-selector", () => ({
  ModelSelector: () => null,
}));

function mockCredits() {
  vi.mocked(useCredits).mockReturnValue({
    data: { balance: "50.00", held: "0", available: "50.00" },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useCredits>);
}

describe("AppHeader — credits pill visibility", () => {
  it("shows the credits pill on a normal chat route", () => {
    mockCredits();
    vi.mocked(usePathname).mockReturnValue("/chat");
    render(<AppHeader />);
    expect(screen.getByText("50.00M")).toBeInTheDocument();
  });

  it("hides the credits pill on /usage — the reference has no pill there", () => {
    mockCredits();
    vi.mocked(usePathname).mockReturnValue("/usage");
    render(<AppHeader />);
    expect(screen.queryByText("50.00M")).not.toBeInTheDocument();
  });
});
