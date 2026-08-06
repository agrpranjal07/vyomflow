import { createContext, useContext, useState, type ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreditsIndicator } from "@/components/chat/credits-indicator";
import { useCredits } from "@/hooks/use-credits";

// S7 §9.2 T5/T6/T7 — same "stub the hook directly, isolate the component"
// pattern as message-list.test.tsx's useMessagesList mock.
vi.mock("@/hooks/use-credits", () => ({
  useCredits: vi.fn(),
}));

// components/ui/popover.tsx's @base-ui/react primitives aren't safely
// renderable in this workspace's RTL environment (only installed under
// frontend/node_modules, a separate React resolution tree — same class of
// problem documented in composer.test.tsx's AttachButton mock and
// vitest.frontend.config.mts's react aliasing notes). Minimal open/close
// stand-in, local to this file, that preserves the trigger→content
// open-state contract CreditsIndicator actually relies on.
const PopoverCtx = createContext<{ open: boolean; setOpen: (v: boolean) => void } | null>(null);
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    return <PopoverCtx.Provider value={{ open, setOpen }}>{children}</PopoverCtx.Provider>;
  },
  PopoverTrigger: ({
    children,
    openOnHover,
    closeDelay: _closeDelay,
    ...props
  }: Record<string, unknown> & { children: ReactNode; openOnHover?: boolean; closeDelay?: number }) => {
    const ctx = useContext(PopoverCtx)!;
    return (
      <button
        type="button"
        onClick={() => ctx.setOpen(!ctx.open)}
        onMouseEnter={openOnHover ? () => ctx.setOpen(true) : undefined}
        {...props}
      >
        {children}
      </button>
    );
  },
  PopoverContent: ({ children, ...props }: Record<string, unknown> & { children: ReactNode }) => {
    const ctx = useContext(PopoverCtx)!;
    if (!ctx.open) return null;
    return <div {...props}>{children}</div>;
  },
}));

function mockCredits(data: { balance: string; held: string; available: string } | undefined, extra: Partial<ReturnType<typeof useCredits>> = {}) {
  vi.mocked(useCredits).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    ...extra,
  } as ReturnType<typeof useCredits>);
}

describe("CreditsIndicator — pill (T5)", () => {
  it("renders the available balance only, no held text, when collapsed", () => {
    mockCredits({ balance: "50.00", held: "8.07", available: "41.93" });
    render(<CreditsIndicator />);
    expect(screen.getByText("41.93M")).toBeInTheDocument();
    expect(screen.queryByText(/held/)).not.toBeInTheDocument();
  });
});

describe("CreditsIndicator — popover held sub-line (T6)", () => {
  it("shows the held sub-line when held > 0", () => {
    mockCredits({ balance: "50.00", held: "8.07", available: "41.93" });
    render(<CreditsIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("8.07M held")).toBeInTheDocument();
  });

  it("omits the held sub-line entirely when held is zero", () => {
    mockCredits({ balance: "50.00", held: "0", available: "50.00" });
    render(<CreditsIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/held/)).not.toBeInTheDocument();
  });
});

describe("CreditsIndicator — hover trigger (Fix 2, credits.md \"Header pill popover\")", () => {
  it("opens the popover on a plain mouse hover, with zero clicks", () => {
    mockCredits({ balance: "50.00", held: "8.07", available: "41.93" });
    render(<CreditsIndicator />);
    expect(screen.queryByText("MONTHLY PLAN")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.getByText("MONTHLY PLAN")).toBeInTheDocument();
  });

  it("aria-label no longer claims a click is required to see plan details", () => {
    mockCredits({ balance: "50.00", held: "8.07", available: "41.93" });
    render(<CreditsIndicator />);
    expect(screen.getByRole("button").getAttribute("aria-label")).not.toMatch(/click for/i);
  });
});

describe("CreditsIndicator — View usage action (S7 §10 Ledger)", () => {
  it("'View usage' is a real navigation to the standalone /usage page, not a popup", () => {
    mockCredits({ balance: "50.00", held: "8.07", available: "41.93" });
    render(<CreditsIndicator />);
    fireEvent.click(screen.getByRole("button", { name: /credits available/i }));
    const link = screen.getByText("View usage");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/usage");
  });
});

describe("CreditsIndicator — loading/error states (T7)", () => {
  it("renders a loading skeleton while loading, not a value", () => {
    mockCredits(undefined, { isLoading: true });
    const { container } = render(<CreditsIndicator />);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText(/M$/)).not.toBeInTheDocument();
  });

  it("on fetch error, renders nothing rather than a fabricated 0.00M, and does not crash", () => {
    mockCredits(undefined, { isError: true });
    const { container } = render(<CreditsIndicator />);
    expect(screen.queryByText("0.00M")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
