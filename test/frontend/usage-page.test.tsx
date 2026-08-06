import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import UsagePage from "@/app/(chat)/usage/page";
import { useCreditUsageEntries, useCreditUsageSummary } from "@/hooks/use-credits";
import type { CreditUsageEntryDTO, CreditUsageSummaryDTO } from "@/contracts/credits";

// Fix 3 — /usage rebuilt as a real tool-grouped dashboard
// (credits.md "/usage full dashboard — re-verified"). Stat cards + Overview
// table come from useCreditUsageSummary; the Detailed View tab now renders
// netted per-run entries via useCreditUsageEntries (credits.md "`/usage` —
// Action/'View details' drill-down gap", netted-rows fold-in) rather than
// raw ledger rows.
vi.mock("@/hooks/use-credits", () => ({
  useCreditUsageSummary: vi.fn(),
  useCreditUsageEntries: vi.fn(),
  useCreditLedgerByRun: vi.fn(),
}));

// "Usage details" modal uses a real base-ui Dialog — not safely renderable
// in this workspace's jsdom (see test/frontend/composer.test.tsx's own
// AttachButton mock for the same reason). Stubbed here so page-composition
// tests can assert *that* a record was selected without exercising the
// real Dialog primitive; the modal's actual content is covered in
// isolation by usage-details-dialog.test.tsx.
vi.mock("@/components/chat/usage/usage-details-dialog", () => ({
  UsageDetailsDialog: ({ record }: { record: { entry: { runId: string } } | null }) =>
    record ? <div data-testid="usage-details-dialog-stub">{record.entry.runId}</div> : null,
}));

function summary(overrides: Partial<CreditUsageSummaryDTO> = {}): CreditUsageSummaryDTO {
  return {
    groups: [
      { toolKey: "none", displayName: "AI Agent Chat", totalDebited: "1.3000", records: 12, latestUsageAt: "2026-08-19T10:00:00.000Z" },
      { toolKey: "crop_image", displayName: "AI Crop Image", totalDebited: "0.9000", records: 5, latestUsageAt: "2026-08-20T10:00:00.000Z" },
    ],
    totalDebitedAll: "2.2000",
    recordsAll: 17,
    categoriesCount: 2,
    periodStart: "2026-08-19T00:00:00.000Z",
    periodEnd: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function mockSummary(data: CreditUsageSummaryDTO | undefined, extra: Partial<ReturnType<typeof useCreditUsageSummary>> = {}) {
  vi.mocked(useCreditUsageSummary).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    ...extra,
  } as unknown as ReturnType<typeof useCreditUsageSummary>);
}

function usageEntry(overrides: Partial<CreditUsageEntryDTO>): CreditUsageEntryDTO {
  return {
    runId: "run_1",
    amount: "2.0000",
    timestamp: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

function mockEntries(entries: CreditUsageEntryDTO[]) {
  vi.mocked(useCreditUsageEntries).mockReturnValue({
    data: { entries },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useCreditUsageEntries>);
}

describe("UsagePage — header + stat cards (real computed values, not fabricated)", () => {
  it("renders the header and the real aggregate totals from the summary endpoint", () => {
    mockSummary(summary());
    mockEntries([]);
    render(<UsagePage />);
    expect(screen.getByRole("heading", { name: "AI Credits Overview" })).toBeInTheDocument();
    expect(screen.getByText("2.20M credits")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders an honest empty state, not a fake date range, when there is no history", () => {
    mockSummary(summary({ groups: [], totalDebitedAll: "0.0000", recordsAll: 0, categoriesCount: 0, periodStart: null, periodEnd: null }));
    mockEntries([]);
    render(<UsagePage />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByText("0.00M credits")).toBeInTheDocument();
  });

  it("renders the Period card's range without a time-of-day (no wrap)", () => {
    mockSummary(summary({ periodStart: "2026-08-19T21:14:00.000Z", periodEnd: "2026-08-21T20:47:00.000Z" }));
    mockEntries([]);
    render(<UsagePage />);
    // Date-only — no "PM"/"AM" clock time in the rendered range.
    const periodValue = screen.getByText(/2026 - .*2026$/);
    expect(periodValue.textContent).not.toMatch(/[AP]M/);
  });

  it("renders one icon swatch per stat card (reference-usage-stat-cards-with-icons.png)", () => {
    mockSummary(summary());
    mockEntries([]);
    render(<UsagePage />);
    // "Records" also appears as an Overview table column header — find the
    // stat-card instance specifically (the one inside a `min-h-20` card).
    function statCardFor(label: string) {
      const match = screen.getAllByText(label).find((el) => el.closest("div.flex.min-h-20"));
      return match?.closest("div.flex.min-h-20") ?? null;
    }
    expect(statCardFor("Total Debited")?.querySelector("svg")).toBeInTheDocument();
    expect(statCardFor("Records")?.querySelector("svg")).toBeInTheDocument();
    expect(statCardFor("Categories")?.querySelector("svg")).toBeInTheDocument();
    expect(statCardFor("Period")?.querySelector("svg")).toBeInTheDocument();
  });
});

describe("UsagePage — Overview table groups correctly", () => {
  it("shows one row per tool group with the correct display name mapping", () => {
    mockSummary(summary());
    mockEntries([]);
    render(<UsagePage />);
    expect(screen.getByText("AI Agent Chat")).toBeInTheDocument();
    expect(screen.getByText("AI Crop Image")).toBeInTheDocument();
    expect(screen.getByText("1.30M")).toBeInTheDocument();
    expect(screen.getByText("0.90M")).toBeInTheDocument();
  });

  it("renders an honest empty state when there are zero groups", () => {
    mockSummary(summary({ groups: [] }));
    mockEntries([]);
    render(<UsagePage />);
    expect(screen.getByText("No credit activity yet.")).toBeInTheDocument();
  });
});

describe("UsagePage — Detailed View tab filters correctly", () => {
  it("switches to Detailed View and renders netted per-run entries scoped to the selected tool", () => {
    mockSummary(summary());
    mockEntries([usageEntry({ runId: "run_a", amount: "0.9000" })]);
    render(<UsagePage />);

    fireEvent.click(screen.getByRole("button", { name: "Detailed View" }));

    expect(screen.getByRole("combobox", { name: /select tool/i })).toBeInTheDocument();
    expect(screen.getByText("0.90M")).toBeInTheDocument();
  });

  it("renders the card header — bold title, real records count, black 'Debited' pill", () => {
    mockSummary(summary());
    mockEntries([usageEntry({ runId: "run_a", amount: "0.9000" })]);
    render(<UsagePage />);

    fireEvent.click(screen.getByRole("button", { name: "Detailed View" }));

    expect(screen.getByRole("heading", { name: "AI Agent Chat usage records" })).toBeInTheDocument();
    expect(screen.getByText("12 records in the selected period")).toBeInTheDocument();
    expect(screen.getByText("Debited")).toBeInTheDocument();
  });

  it("renders the caption block above the dropdown", () => {
    mockSummary(summary());
    mockEntries([usageEntry({ runId: "run_a", amount: "0.9000" })]);
    render(<UsagePage />);

    fireEvent.click(screen.getByRole("button", { name: "Detailed View" }));

    expect(screen.getByText("Detailed records")).toBeInTheDocument();
    expect(screen.getByText("Select a usage category, then open a record to inspect step costs.")).toBeInTheDocument();
  });
});

describe("UsagePage — Overview 'View details' drill-down (credits.md Action-column gap)", () => {
  it("switches to Detailed View with the clicked row's tool pre-selected", () => {
    mockSummary(summary());
    mockEntries([usageEntry({ runId: "run_a", amount: "0.9000" })]);
    render(<UsagePage />);

    const actionButtons = screen.getAllByRole("button", { name: /view details/i });
    // Second Overview row is "AI Crop Image" (toolKey "crop_image").
    fireEvent.click(actionButtons[1]!);

    expect(screen.getByRole("button", { name: "Detailed View" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "AI Crop Image usage records" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /select tool/i })).toHaveValue("crop_image");
  });

  it("opens the Usage details modal for a Detailed View row, scoped to that entry's runId", () => {
    mockSummary(summary());
    mockEntries([usageEntry({ runId: "run_click", amount: "0.9000" })]);
    render(<UsagePage />);

    fireEvent.click(screen.getByRole("button", { name: "Detailed View" }));
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));

    expect(screen.getByTestId("usage-details-dialog-stub")).toHaveTextContent("run_click");
  });
});
