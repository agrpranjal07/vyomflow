import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreditLedgerList } from "@/components/chat/credit-ledger-view";
import { useCreditLedger } from "@/hooks/use-credits";
import type { CreditLedgerEntryDTO } from "@/contracts/credits";

// S7 §10 "Ledger" — same "stub the hook directly" isolation pattern as
// credits-indicator.test.tsx. CreditLedgerList is rendered inside
// UsageDetailedView's card (app/(chat)/usage), its only consumer as of the
// "Detailed View" reshape (credits.md "`/usage` — Action/'View details'
// drill-down gap" fold-in): a 3-column `Credits Used | Timestamp |
// Details` table, plain unsigned amount, no RESERVE/CAPTURE/RELEASE/USAGE
// kind label (reference-usage-detailed-view-target.png).
vi.mock("@/hooks/use-credits", () => ({
  useCreditLedger: vi.fn(),
}));

function mockLedger(
  pages: CreditLedgerEntryDTO[][] | undefined,
  extra: Partial<ReturnType<typeof useCreditLedger>> = {},
) {
  vi.mocked(useCreditLedger).mockReturnValue({
    data: pages
      ? { pages: pages.map((items) => ({ items, nextCursor: null })), pageParams: pages.map(() => undefined) }
      : undefined,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...extra,
  } as unknown as ReturnType<typeof useCreditLedger>);
}

function entry(overrides: Partial<CreditLedgerEntryDTO>): CreditLedgerEntryDTO {
  return {
    id: "led_1",
    kind: "RESERVE",
    amount: "5.0000",
    createdAt: "2026-08-21T10:00:00.000Z",
    runId: "run_1",
    toolInvocationId: null,
    ...overrides,
  };
}

describe("CreditLedgerList — loading/empty/error states", () => {
  it("renders a loading state", () => {
    mockLedger(undefined, { isLoading: true });
    render(<CreditLedgerList />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an empty state with no fabricated rows", () => {
    mockLedger([[]]);
    render(<CreditLedgerList />);
    expect(screen.getByText("No credit activity yet.")).toBeInTheDocument();
  });

  it("renders an error state, not a crash", () => {
    mockLedger(undefined, { isError: true });
    render(<CreditLedgerList />);
    expect(screen.getByText("Couldn't load usage history.")).toBeInTheDocument();
  });
});

describe("CreditLedgerList — table shape: Credits Used | Timestamp | Details", () => {
  it("renders the column header row", () => {
    mockLedger([[entry({ kind: "CAPTURE", amount: "3.5000" })]]);
    render(<CreditLedgerList />);
    expect(screen.getByRole("columnheader", { name: "Credits Used" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Timestamp" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Details" })).toBeInTheDocument();
  });

  it("renders a plain unsigned amount and no kind label, for every kind", () => {
    mockLedger([
      [
        entry({ id: "a", kind: "RESERVE", amount: "5.0000" }),
        entry({ id: "b", kind: "CAPTURE", amount: "3.5000" }),
        entry({ id: "c", kind: "RELEASE", amount: "1.2500" }),
        entry({ id: "d", kind: "USAGE", amount: "0.0000" }),
      ],
    ]);
    render(<CreditLedgerList />);
    expect(screen.getByText("5.00M")).toBeInTheDocument();
    expect(screen.getByText("3.50M")).toBeInTheDocument();
    expect(screen.getByText("1.25M")).toBeInTheDocument();
    expect(screen.getByText("0.00M")).toBeInTheDocument();
    expect(screen.queryByText("Reserved")).not.toBeInTheDocument();
    expect(screen.queryByText("Captured")).not.toBeInTheDocument();
    expect(screen.queryByText("Released")).not.toBeInTheDocument();
    expect(screen.queryByText(/^[+-]/)).not.toBeInTheDocument();
  });

  it("renders a 'View details' button per row when onViewDetails is provided, calling it with the row's entry", () => {
    const onViewDetails = vi.fn();
    mockLedger([[entry({ id: "a", kind: "CAPTURE", amount: "3.5000" })]]);
    render(<CreditLedgerList onViewDetails={onViewDetails} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(onViewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("omits the Details button when onViewDetails is not provided", () => {
    mockLedger([[entry({ id: "a", kind: "CAPTURE", amount: "3.5000" })]]);
    render(<CreditLedgerList />);
    expect(screen.queryByRole("button", { name: /view details/i })).not.toBeInTheDocument();
  });
});

describe("CreditLedgerList — pagination", () => {
  it("shows a Load more control only when a next page exists, and calls fetchNextPage", () => {
    const fetchNextPage = vi.fn();
    mockLedger([[entry({ id: "a" })]], { hasNextPage: true, fetchNextPage });
    render(<CreditLedgerList />);
    const button = screen.getByText("Load more");
    fireEvent.click(button);
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("omits Load more when there is no next page", () => {
    mockLedger([[entry({ id: "a" })]], { hasNextPage: false });
    render(<CreditLedgerList />);
    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  });
});
