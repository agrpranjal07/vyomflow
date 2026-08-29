import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageDetailedView } from "@/components/chat/usage/usage-detailed-view";
import { AGGREGATE_TOOL_KEY, type CreditUsageGroupDTO } from "@/contracts/credits";

// 2026-08-29 UX fix (credits.md): groups[0] is now the synthetic
// AGGREGATE_TOOL_KEY ("VyomFlow") cross-tool total, which renders
// UsageChatBreakdownList instead of the per-tool UsageEntryList. Both
// children are stubbed with distinguishable markers so this file tests
// UsageDetailedView's own selection/switching logic, not either child's
// internals (those have their own test files).
vi.mock("@/components/chat/usage/usage-chat-breakdown-list", () => ({
  UsageChatBreakdownList: (_props: { period: string; onViewDetails: (entry: unknown) => void }) => (
    <div data-testid="chat-breakdown-marker">chat breakdown</div>
  ),
}));
vi.mock("@/components/chat/usage/usage-entry-list", () => ({
  UsageEntryList: ({ tool }: { tool: string; period: string }) => <div data-testid="entry-list-marker">entry list for {tool}</div>,
}));

function group(overrides: Partial<CreditUsageGroupDTO> = {}): CreditUsageGroupDTO {
  return {
    toolKey: "crop_image",
    displayName: "Crop Image",
    totalDebited: "1.5000",
    records: 3,
    latestUsageAt: "2026-08-21T14:19:25.000Z",
    ...overrides,
  };
}

function aggregateGroup(overrides: Partial<CreditUsageGroupDTO> = {}): CreditUsageGroupDTO {
  return group({
    toolKey: AGGREGATE_TOOL_KEY,
    displayName: "VyomFlow",
    totalDebited: "4.2000",
    records: 9,
    ...overrides,
  });
}

describe("UsageDetailedView — aggregate group selection", () => {
  it("defaults to groups[0] and renders UsageChatBreakdownList (not UsageEntryList) when it's the aggregate group", () => {
    const groups = [aggregateGroup(), group()];
    render(
      <UsageDetailedView groups={groups} isLoading={false} selectedTool={undefined} onSelectTool={vi.fn()} onViewDetails={vi.fn()} onViewChatDetails={vi.fn()} period="all" />,
    );
    expect(screen.getByTestId("chat-breakdown-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("entry-list-marker")).not.toBeInTheDocument();
  });

  it("shows real nonzero VyomFlow total in the header, not the old always-zero bare-LLM bucket", () => {
    const groups = [aggregateGroup({ records: 9 }), group()];
    render(
      <UsageDetailedView groups={groups} isLoading={false} selectedTool={undefined} onSelectTool={vi.fn()} onViewDetails={vi.fn()} onViewChatDetails={vi.fn()} period="all" />,
    );
    expect(screen.getByText("VyomFlow usage records")).toBeInTheDocument();
    expect(screen.getByText("9 records in the selected period")).toBeInTheDocument();
  });

  it("renders UsageEntryList (not UsageChatBreakdownList) when a non-aggregate group is selected", () => {
    const groups = [aggregateGroup(), group({ toolKey: "crop_image", displayName: "Crop Image" })];
    render(
      <UsageDetailedView
        groups={groups}
        isLoading={false}
        selectedTool="crop_image"
        onSelectTool={vi.fn()}
        onViewDetails={vi.fn()}
        onViewChatDetails={vi.fn()}
        period="all"
      />,
    );
    expect(screen.getByTestId("entry-list-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-breakdown-marker")).not.toBeInTheDocument();
    expect(screen.getByText("Crop Image usage records")).toBeInTheDocument();
  });

  it("switches from the chat breakdown to the entry list when the dropdown selection changes", () => {
    const onSelectTool = vi.fn();
    const groups = [aggregateGroup(), group({ toolKey: "crop_image", displayName: "Crop Image" })];
    const { rerender } = render(
      <UsageDetailedView groups={groups} isLoading={false} selectedTool={undefined} onSelectTool={onSelectTool} onViewDetails={vi.fn()} onViewChatDetails={vi.fn()} period="all" />,
    );
    expect(screen.getByTestId("chat-breakdown-marker")).toBeInTheDocument();

    // Simulate the dropdown's onChange invoking onSelectTool, then the page
    // re-rendering with the newly selected tool lifted into `selectedTool`.
    rerender(
      <UsageDetailedView
        groups={groups}
        isLoading={false}
        selectedTool="crop_image"
        onSelectTool={onSelectTool}
        onViewDetails={vi.fn()}
        onViewChatDetails={vi.fn()}
        period="all"
      />,
    );
    expect(screen.getByTestId("entry-list-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-breakdown-marker")).not.toBeInTheDocument();
  });
});
