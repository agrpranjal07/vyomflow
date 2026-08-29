import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { UsageChatBreakdownList } from "@/components/chat/usage/usage-chat-breakdown-list";
import { useCreditUsageEntriesByChat } from "@/hooks/use-credits";
import type { CreditUsageChatEntryDTO } from "@/contracts/credits";

// 2026-08-29 UX fix (credits.md): the "VyomFlow" aggregate group's record
// table — one row per chat, netted across every tool + bare-LLM usage
// combined, not one row per run within a single tool bucket the way
// UsageEntryList renders. Same "stub the hook directly" pattern as
// usage-entry-list.test.tsx's useCreditUsageEntries mock.
vi.mock("@/hooks/use-credits", () => ({
  useCreditUsageEntriesByChat: vi.fn(),
}));

function entry(overrides: Partial<CreditUsageChatEntryDTO> = {}): CreditUsageChatEntryDTO {
  return {
    chatId: "chat_1",
    chatTitle: "Merge two videos",
    amount: "0.2900",
    timestamp: "2026-08-21T14:19:25.000Z",
    ...overrides,
  };
}

function mockEntries(
  data: { entries: CreditUsageChatEntryDTO[] } | undefined,
  extra: Partial<ReturnType<typeof useCreditUsageEntriesByChat>> = {},
) {
  vi.mocked(useCreditUsageEntriesByChat).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    ...extra,
  } as unknown as ReturnType<typeof useCreditUsageEntriesByChat>);
}

const noop = () => {};

describe("UsageChatBreakdownList — loading/empty/error states", () => {
  it("renders a loading state", () => {
    mockEntries(undefined, { isLoading: true });
    render(<UsageChatBreakdownList period="all" onViewDetails={noop} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an empty state with no fabricated rows", () => {
    mockEntries({ entries: [] });
    render(<UsageChatBreakdownList period="all" onViewDetails={noop} />);
    expect(screen.getByText("No credit activity yet.")).toBeInTheDocument();
  });

  it("renders an error state, not a crash", () => {
    mockEntries(undefined, { isError: true });
    render(<UsageChatBreakdownList period="all" onViewDetails={noop} />);
    expect(screen.getByText("Couldn't load usage records.")).toBeInTheDocument();
  });
});

describe("UsageChatBreakdownList — one row per chat, no Chat column, Details opens the drill-down dialog", () => {
  it("renders the column header row without a dedicated Chat column", () => {
    mockEntries({ entries: [entry()] });
    render(<UsageChatBreakdownList period="all" onViewDetails={noop} />);
    expect(screen.queryByRole("columnheader", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Credits Used" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Timestamp" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Details" })).toBeInTheDocument();
  });

  it("renders 2 rows for 2 chats with formatted amounts, and Details calls onViewDetails with that row's entry", () => {
    const chatA = entry({ chatId: "chat_a", chatTitle: "Crop my photo", amount: "0.2900" });
    const chatB = entry({ chatId: "chat_b", chatTitle: "Merge two videos", amount: "0.1100" });
    mockEntries({ entries: [chatA, chatB] });

    const onViewDetails = vi.fn();
    render(<UsageChatBreakdownList period="all" onViewDetails={onViewDetails} />);

    expect(screen.getByText("0.29M")).toBeInTheDocument();
    expect(screen.getByText("0.11M")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 entries

    const buttons = screen.getAllByRole("button", { name: /view details/i });
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    expect(onViewDetails).toHaveBeenCalledWith(chatA);
    buttons[1]!.click();
    expect(onViewDetails).toHaveBeenCalledWith(chatB);
  });
});
