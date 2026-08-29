"use client";

import { formatCredits } from "@/lib/format";
import { UsageEntryList } from "@/components/chat/usage/usage-entry-list";
import { UsageChatBreakdownList } from "@/components/chat/usage/usage-chat-breakdown-list";
import {
  AGGREGATE_TOOL_KEY,
  type CreditUsageChatEntryDTO,
  type CreditUsageEntryDTO,
  type CreditUsageGroupDTO,
  type UsagePeriod,
} from "@/contracts/credits";

/**
 * Detailed View tab (credits.md "/usage full dashboard": a dropdown of
 * tool groups + a per-record table for the selected tool), now wrapped in
 * its own bordered card per reference-usage-detailed-view-card.png: bold
 * "{displayName} usage records" title, "{records} records in the selected
 * period" subtitle (the real count from the selected group, not a
 * recomputed one), and a static black "Debited" pill — we only ever show
 * debited amounts here, so this is an honest label, not a fake filter
 * control. Selection is lifted to the page (`selectedTool`/`onSelectTool`)
 * so Overview's "View details" action can pre-select a tool when switching
 * tabs, rather than this component owning unreachable internal state.
 *
 * Caption row above the dropdown ("Detailed records" / "Select a usage
 * category, then open a record to inspect step costs.") is the reference's
 * own exact copy (reference-usage-detailed-view-target.png) — this app had
 * no such caption before; the bare `<select>` sat alone.
 *
 * Record table below the header is `UsageEntryList` — one row per run
 * (netted CAPTURE/USAGE total), not one row per raw ledger entry, so its
 * row count actually matches `selectedGroup.records` above it (credits.md
 * "`/usage` — Action/'View details' drill-down gap", netted-rows fold-in).
 * `groups[0]` is always the synthetic `AGGREGATE_TOOL_KEY` ("VyomFlow")
 * group (2026-08-29 UX fix — see getCreditUsageSummary), which renders
 * `UsageChatBreakdownList` instead: one row per chat across every tool
 * combined, since there's no single tool bucket to net runs within.
 */
export function UsageDetailedView({
  groups,
  isLoading,
  selectedTool,
  onSelectTool,
  onViewDetails,
  onViewChatDetails,
  period,
}: {
  groups: CreditUsageGroupDTO[] | undefined;
  isLoading: boolean;
  selectedTool: string | undefined;
  onSelectTool: (toolKey: string) => void;
  onViewDetails: (entry: CreditUsageEntryDTO, group: CreditUsageGroupDTO) => void;
  onViewChatDetails: (entry: CreditUsageChatEntryDTO) => void;
  period: UsagePeriod;
}) {
  if (isLoading) return <p className="p-4 text-sm text-text-secondary">Loading…</p>;
  if (!groups || groups.length === 0) return <p className="p-4 text-sm text-text-secondary">No credit activity yet.</p>;

  const selected = selectedTool ?? groups[0]!.toolKey;
  const selectedGroup = groups.find((group) => group.toolKey === selected) ?? groups[0]!;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-border-hairline bg-card p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-bold text-text-primary">Detailed records</h2>
          <p className="text-sm text-text-secondary">Select a usage category, then open a record to inspect step costs.</p>
        </div>
        <select
          value={selected}
          onChange={(e) => onSelectTool(e.target.value)}
          className="w-64 shrink-0 rounded-[var(--radius-sm)] border border-border-hairline bg-card px-3 py-2 text-sm text-text-primary"
          aria-label="Select tool"
        >
          {groups.map((group) => (
            <option key={group.toolKey} value={group.toolKey}>
              {group.displayName} - {formatCredits(Number(group.totalDebited))}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border-hairline bg-card shadow-none">
        <div className="flex items-start justify-between gap-3 border-b border-border-hairline p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold text-text-primary">{selectedGroup.displayName} usage records</h2>
            <p className="text-sm text-text-secondary">{selectedGroup.records} records in the selected period</p>
          </div>
          <span className="shrink-0 rounded-pill bg-foreground px-3 py-1 text-xs font-medium text-background">Debited</span>
        </div>
        {selected === AGGREGATE_TOOL_KEY ? (
          <UsageChatBreakdownList period={period} onViewDetails={onViewChatDetails} />
        ) : (
          <UsageEntryList tool={selected} period={period} onViewDetails={(entry) => onViewDetails(entry, selectedGroup)} />
        )}
      </div>
    </div>
  );
}
