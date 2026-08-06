import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageDetailsDialogBody } from "@/components/chat/usage/usage-details-dialog";
import type { CreditRunStepsDTO, CreditUsageEntryDTO, CreditUsageGroupDTO } from "@/contracts/credits";

// S7 "/usage — Action/'View details' drill-down gap" — the modal's actual
// content, tested in isolation without the base-ui Dialog wrapper (not
// safely renderable in this workspace's jsdom, same posture as this
// suite's other Dialog-using components). `entry` here is the already-
// netted CreditUsageEntryDTO row (netted-rows fold-in), not a raw ledger
// row — record.entry.amount/timestamp are that run's own totals.
function entry(overrides: Partial<CreditUsageEntryDTO> = {}): CreditUsageEntryDTO {
  return {
    runId: "run_1",
    amount: "0.2900",
    timestamp: "2026-08-21T14:19:25.000Z",
    ...overrides,
  };
}

function group(overrides: Partial<CreditUsageGroupDTO> = {}): CreditUsageGroupDTO {
  return {
    toolKey: "none",
    displayName: "AI Agent Chat",
    totalDebited: "1.3000",
    records: 12,
    latestUsageAt: "2026-08-21T14:19:25.000Z",
    ...overrides,
  };
}

function steps(overrides: Partial<CreditRunStepsDTO> = {}): CreditRunStepsDTO {
  return {
    chatId: "6a8810d58d1ab88b810c03a5",
    items: [
      { id: "s1", kind: "RESERVE", amount: "0.2000", createdAt: "2026-08-21T14:18:22.000Z", runId: "run_1", toolInvocationId: null, toolName: null },
      { id: "s2", kind: "CAPTURE", amount: "0.1600", createdAt: "2026-08-21T14:18:54.000Z", runId: "run_1", toolInvocationId: "ti_gpt", toolName: "generate_image" },
      { id: "s3", kind: "RESERVE", amount: "0.0700", createdAt: "2026-08-21T14:19:25.000Z", runId: "run_1", toolInvocationId: null, toolName: null },
    ],
    ...overrides,
  };
}

describe("UsageDetailsDialogBody — real record + step-breakdown data", () => {
  it("renders the 4-column info row from the real record and query response", () => {
    render(<UsageDetailsDialogBody record={{ entry: entry(), group: group() }} data={steps()} isLoading={false} isError={false} />);
    expect(screen.getByText("6a8810d58d1ab88b810c03a5")).toBeInTheDocument();
    expect(screen.getAllByText("AI Agent Chat").length).toBeGreaterThan(0);
    expect(screen.getByText("0.29M")).toBeInTheDocument();
  });

  it("labels each step honestly: KIND_LABELS base, prefixed with the step's own tool name where present", () => {
    render(<UsageDetailsDialogBody record={{ entry: entry(), group: group() }} data={steps()} isLoading={false} isError={false} />);
    expect(screen.getAllByText("Reserved")).toHaveLength(2);
    expect(screen.getByText("AI Generate Image — Captured")).toBeInTheDocument();
    expect(screen.getByText("3 steps")).toBeInTheDocument();
  });

  it("renders a loading state, not a fabricated row", () => {
    render(<UsageDetailsDialogBody record={{ entry: entry(), group: group() }} data={undefined} isLoading={true} isError={false} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an error state, not a crash", () => {
    render(<UsageDetailsDialogBody record={{ entry: entry(), group: group() }} data={undefined} isLoading={false} isError={true} />);
    expect(screen.getByText("Couldn't load step breakdown.")).toBeInTheDocument();
  });

  it("renders an honest empty state when a run somehow has zero ledger steps", () => {
    render(
      <UsageDetailsDialogBody
        record={{ entry: entry(), group: group() }}
        data={{ chatId: "chat_1", items: [] }}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText("No steps recorded for this entry.")).toBeInTheDocument();
    expect(screen.getByText("0 steps")).toBeInTheDocument();
  });
});
