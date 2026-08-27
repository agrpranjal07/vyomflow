import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { clerkSignOut } from "@clerk/nextjs";
import { CreditPaywallDialog } from "@/components/credits/credit-paywall-dialog";
import { useCredits } from "@/hooks/use-credits";

// @base-ui/react's Dialog isn't safely renderable in this workspace's RTL
// environment — see mocks/ui-dialog.tsx's header comment.
vi.mock("@/components/ui/dialog", () => import("./mocks/ui-dialog"));
vi.mock("@/hooks/use-credits", () => ({ useCredits: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCredits).mockReturnValue({
    data: { balance: "0", held: "0", available: "0" },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useCredits>);
});

describe("CreditPaywallDialog", () => {
  it("renders nothing when closed", () => {
    render(<CreditPaywallDialog open={false} reason={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Out of credits")).not.toBeInTheDocument();
  });

  it.each([
    ["message", /message couldn't be sent/i],
    ["tool", /step couldn't run/i],
    ["upload", /file couldn't be uploaded/i],
  ] as const)("renders the %s reason copy", (reason, expected) => {
    render(<CreditPaywallDialog open reason={reason} onOpenChange={vi.fn()} />);
    expect(screen.getByText("Out of credits")).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("states the new-account starting grant in the copy", () => {
    render(<CreditPaywallDialog open reason="message" onOpenChange={vi.fn()} />);
    expect(screen.getByText(/100 more units/)).toBeInTheDocument();
  });

  it("signs the user out with a redirect to sign-in on the primary CTA", () => {
    render(<CreditPaywallDialog open reason="message" onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with another id/i }));
    expect(clerkSignOut).toHaveBeenCalledWith({ redirectUrl: "/sign-in" });
  });
});
