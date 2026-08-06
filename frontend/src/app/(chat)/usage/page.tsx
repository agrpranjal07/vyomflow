"use client";

import { useState } from "react";
import { useCreditUsageSummary } from "@/hooks/use-credits";
import { UsageStatCards } from "@/components/chat/usage/usage-stat-cards";
import { UsageTabs, type UsageTab } from "@/components/chat/usage/usage-tabs";
import { UsageOverviewTable } from "@/components/chat/usage/usage-overview-table";
import { UsageDetailedView } from "@/components/chat/usage/usage-detailed-view";
import { UsageDetailsDialog, type UsageDetailsRecord } from "@/components/chat/usage/usage-details-dialog";
import type { CreditUsageEntryDTO, CreditUsageGroupDTO } from "@/contracts/credits";

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
 * existing tokens. `Show`/`Period` filter dropdowns and the "AI Credit
 * Adjustment" row are deliberately omitted — no backing filter modes or
 * admin-adjustment concept exist in this project (standing anti-fabrication
 * decision, see .claude/evidence/credits.md).
 *
 * `selectedTool` is owned here (not inside UsageDetailedView) so Overview's
 * "View details" action (credits.md "`/usage` — Action/'View details'
 * drill-down gap") can switch tabs *and* pre-select a tool in one click.
 * `detailsRecord` similarly owns which ledger row the "Usage details"
 * modal is open for.
 */
export default function UsagePage() {
  const { data, isLoading, isError } = useCreditUsageSummary();
  const [tab, setTab] = useState<UsageTab>("overview");
  const [selectedTool, setSelectedTool] = useState<string | undefined>(undefined);
  const [detailsRecord, setDetailsRecord] = useState<UsageDetailsRecord | null>(null);

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
        <h1 className="text-[30px] font-bold leading-9 text-text-primary">AI Credits Overview</h1>
        <p className="mt-1.5 text-lg leading-7 text-text-secondary">Track your AI usage and optimize credit spend</p>

        <div className="mt-6">
          <UsageStatCards data={data} isLoading={isLoading} />
        </div>

        <div className="mt-6">
          <UsageTabs active={tab} onChange={setTab} />
        </div>

        <div className="mt-4">
          {tab === "overview" ? (
            <UsageOverviewTable
              groups={data?.groups}
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
            />
          )}
        </div>
      </div>

      <UsageDetailsDialog record={detailsRecord} onOpenChange={(open) => !open && setDetailsRecord(null)} />
    </div>
  );
}
