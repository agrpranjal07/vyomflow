"use client";

import { formatCredits } from "@/lib/format";
import { formatEntryDate, ViewDetailsButton } from "@/components/chat/credit-ledger-view";
import type { CreditUsageGroupDTO } from "@/contracts/credits";

/**
 * Tool-grouped Overview table (credits.md "/usage full dashboard": Tool
 * Name / Total Debited / Records / Latest Usage). Right-aligned "Action"
 * column with a per-row "View details" pill (credits.md "`/usage` —
 * Action/'View details' drill-down gap", reference-usage-overview-with-
 * action-column.png) — clicking it hands the row's toolKey to
 * `onViewDetails`, which the page composes into "switch to Detailed View,
 * pre-select this tool" rather than this table owning tab/selection state
 * itself.
 */
export function UsageOverviewTable({
  groups,
  isLoading,
  isError,
  onViewDetails,
}: {
  groups: CreditUsageGroupDTO[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onViewDetails: (toolKey: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border-hairline bg-card shadow-none">
      {isLoading ? (
        <p className="p-4 text-sm text-text-secondary">Loading…</p>
      ) : isError ? (
        <p className="p-4 text-sm text-text-secondary">Couldn&apos;t load usage summary.</p>
      ) : !groups || groups.length === 0 ? (
        <p className="p-4 text-sm text-text-secondary">No credit activity yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-hairline text-left text-xs font-medium uppercase text-text-secondary">
              <th className="p-4 font-medium">Tool Name</th>
              <th className="p-4 text-right font-medium">Total Debited</th>
              <th className="p-4 text-right font-medium">Records</th>
              <th className="p-4 text-right font-medium">Latest Usage</th>
              <th className="p-4 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr
                key={group.toolKey}
                className="border-b border-border-hairline transition-colors last:border-b-0 hover:bg-surface-thumbnail/50"
              >
                <td className="p-4 font-medium text-text-primary">{group.displayName}</td>
                <td className="p-4 text-right align-middle font-semibold text-text-primary">
                  {formatCredits(Number(group.totalDebited))}
                </td>
                <td className="p-4 text-right align-middle text-text-secondary">{group.records}</td>
                <td className="p-4 text-right align-middle text-text-secondary">
                  {group.latestUsageAt ? formatEntryDate(group.latestUsageAt) : "—"}
                </td>
                <td className="p-4 text-right align-middle">
                  <ViewDetailsButton onClick={() => onViewDetails(group.toolKey)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
