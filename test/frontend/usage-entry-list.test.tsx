import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsageEntryList } from "@/components/chat/usage/usage-entry-list";
import { useCreditUsageEntries } from "@/hooks/use-credits";
import type { CreditUsageEntryDTO } from "@/contracts/credits";

// credits.md "`/usage` — Action/'View details' drill-down gap", netted-rows
// fold-in: UsageEntryList replaces CreditLedgerList as the Detailed View
// tab's data source — one row per netted run, not one per raw ledger row.
vi.mock("@/hooks/use-credits", () => ({
  useCreditUsageEntries: vi.fn(),
}));

function entry(overrides: Partial<CreditUsageEntryDTO> = {}): CreditUsageEntryDTO {
  return {
    runId: "run_1",
    amount: "0.2900",
    timestamp: "2026-08-21T14:19:25.000Z",
    ...overrides,
  };
}

function mockEntries(
  data: { entries: CreditUsageEntryDTO[] } | undefined,
  extra: Partial<ReturnType<typeof useCreditUsageEntries>> = {},
) {
  vi.mocked(useCreditUsageEntries).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    ...extra,
  } as unknown as ReturnType<typeof useCreditUsageEntries>);
}

describe("UsageEntryList — loading/empty/error states", () => {
  it("renders a loading state", () => {
    mockEntries(undefined, { isLoading: true });
    render(<UsageEntryList tool="none" onViewDetails={vi.fn()} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an empty state with no fabricated rows", () => {
    mockEntries({ entries: [] });
    render(<UsageEntryList tool="none" onViewDetails={vi.fn()} />);
    expect(screen.getByText("No credit activity yet.")).toBeInTheDocument();
  });

  it("renders an error state, not a crash", () => {
    mockEntries(undefined, { isError: true });
    render(<UsageEntryList tool="none" onViewDetails={vi.fn()} />);
    expect(screen.getByText("Couldn't load usage records.")).toBeInTheDocument();
  });
});

describe("UsageEntryList — netted rows: one per run, real amount/timestamp", () => {
  it("renders the column header row", () => {
    mockEntries({ entries: [entry()] });
    render(<UsageEntryList tool="none" onViewDetails={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Credits Used" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Timestamp" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Details" })).toBeInTheDocument();
  });

  it("renders exactly one row per entry, even though a run can bundle multiple raw ledger rows behind it", () => {
    mockEntries({
      entries: [
        entry({ runId: "run_a", amount: "0.2900" }),
        entry({ runId: "run_b", amount: "0.1100" }),
      ],
    });
    render(<UsageEntryList tool="none" onViewDetails={vi.fn()} />);
    expect(screen.getByText("0.29M")).toBeInTheDocument();
    expect(screen.getByText("0.11M")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 entries
  });

  it("calls onViewDetails with the clicked entry", () => {
    const onViewDetails = vi.fn();
    mockEntries({ entries: [entry({ runId: "run_click" })] });
    render(<UsageEntryList tool="none" onViewDetails={onViewDetails} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(onViewDetails).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_click" }));
  });
});
