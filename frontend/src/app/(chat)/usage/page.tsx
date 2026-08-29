"use client";

import { useState } from "react";
import { useCreditUsageSummary } from "@/hooks/use-credits";
import { UsageStatCards } from "@/components/chat/usage/usage-stat-cards";
import { UsageTabs, type UsageTab } from "@/components/chat/usage/usage-tabs";
import { UsageOverviewTable } from "@/components/chat/usage/usage-overview-table";
import { UsageDetailedView } from "@/components/chat/usage/usage-detailed-view";
import { UsageDetailsDialog, type UsageDetailsRecord } from "@/components/chat/usage/usage-details-dialog";
import { UsageChatDetailsDialog } from "@/components/chat/usage/usage-chat-details-dialog";
import { UsagePeriodSelect } from "@/components/chat/usage/usage-period-select";
import {
  AGGREGATE_TOOL_KEY,
  type CreditUsageChatEntryDTO,
  type CreditUsageEntryDTO,
  type CreditUsageGroupDTO,
  type UsagePeriod,
} from "@/contracts/credits";

/**
 * Standalone /usage page (reference: the reference product's /usage page, "AI Credits
 * Overview" — reached from the credits popover's "View usage" row, a real
 * navigation there, not a popup). Rebuilt as a real tool-grouped dashboard
 * (credits.md "/usage full dashboard — re-verified": a GROUP BY
 * toolInvocation.name aggregation over CreditLedger CAPTURE/USAGE rows is
 * honestly derivable from data already persisted, not fabrication) —
 * supersedes the earlier flat-ledger-only version. Header typography
 * (30px/700 title, 18px/400 text-secondary subtitle) and the stat-card/
 * table/tab class systems are DOM/computed-style-verified against the live
 * reference (reference-usage-page-desktop.md), mapped onto this app's
 * existing tokens. The "AI Credit Adjustment" row is deliberately omitted —
 * no admin-adjustment concept exists in this project (standing
 * anti-fabrication decision, see .claude/evidence/credits.md). The `Period`
 * filter (2026-08-29) is real, unlike the reference's `Show` filter (still
 * omitted — no backing filter mode exists): `?period=` scopes the summary/
 * entries endpoints to a real rolling `createdAt` window, not a fabricated
 * billing-period concept.
 *
 * `selectedTool` is owned here (not inside UsageDetailedView) so Overview's
 * "View details" action (credits.md "`/usage` — Action/'View details'
 * drill-down gap") can switch tabs *and* pre-select a tool in one click.
 * `detailsRecord` similarly owns which ledger row the "Usage details"
 * modal is open for.
 */
export default function UsagePage() {
  const [period, setPeriod] = useState<UsagePeriod>("all");
  const { data, isLoading, isError } = useCreditUsageSummary(period);
  const [tab, setTab] = useState<UsageTab>("overview");
  const [selectedTool, setSelectedTool] = useState<string | undefined>(undefined);
  const [detailsRecord, setDetailsRecord] = useState<UsageDetailsRecord | null>(null);
  const [chatDetailsEntry, setChatDetailsEntry] = useState<CreditUsageChatEntryDTO | null>(null);

  function handleOverviewViewDetails(toolKey: string) {
    setSelectedTool(toolKey);
    setTab("detailed");
  }

  function handleRowViewDetails(entry: CreditUsageEntryDTO, group: CreditUsageGroupDTO) {
    setDetailsRecord({ entry, group });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      {/* max-w-[1472px] is this app's own existing full-dashboard-page width
          (tasks/page.tsx) — reused here rather than the narrower max-w-3xl,
          which read visibly narrower than the reference's own full-width
          dashboard layout. */}
      <div className="mx-auto w-full max-w-[1472px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[30px] font-bold leading-9 text-text-primary">AI Credits Overview</h1>
            <p className="mt-1.5 text-lg leading-7 text-text-secondary">Track your AI usage and optimize credit spend</p>
          </div>
          <UsagePeriodSelect value={period} onChange={setPeriod} />
        </div>

        <div className="mt-6">
          <UsageStatCards data={data} isLoading={isLoading} />
        </div>

        <div className="mt-6">
          <UsageTabs active={tab} onChange={setTab} />
        </div>

        <div className="mt-4">
          {tab === "overview" ? (
            <UsageOverviewTable
              // The "VyomFlow" aggregate (groups[0], 2026-08-29) is the sum of
              // every row below it — Overview is a per-category breakdown, so
              // showing the total as a peer row would read as a real category
              // and double the visible total. The stat cards above already
              // show the true cross-tool total; the aggregate is only a
              // *selectable* view in the Detailed tab's dropdown.
              groups={data?.groups?.filter((group) => group.toolKey !== AGGREGATE_TOOL_KEY)}
              isLoading={isLoading}
              isError={isError}
              onViewDetails={handleOverviewViewDetails}
            />
          ) : (
            <UsageDetailedView
              groups={data?.groups}
              isLoading={isLoading}
              selectedTool={selectedTool}
              onSelectTool={setSelectedTool}
              onViewDetails={handleRowViewDetails}
              onViewChatDetails={setChatDetailsEntry}
              period={period}
            />
          )}
        </div>
      </div>

      <UsageDetailsDialog record={detailsRecord} onOpenChange={(open) => !open && setDetailsRecord(null)} />
      <UsageChatDetailsDialog entry={chatDetailsEntry} onOpenChange={(open) => !open && setChatDetailsEntry(null)} />
    </div>
  );
}
