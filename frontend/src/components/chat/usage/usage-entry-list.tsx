"use client";

import { formatCredits } from "@/lib/format";
import { formatEntryDate, ViewDetailsButton } from "@/components/chat/credit-ledger-view";
import { useCreditUsageEntries } from "@/hooks/use-credits";
import type { CreditUsageEntryDTO } from "@/contracts/credits";

/**
 * Detailed View tab's record table (credits.md "`/usage` — Action/'View
 * details' drill-down gap", netted-rows fold-in) — one row per netted
 * usage entry (one per run within the selected tool bucket, via the
 * backend's `listUsageEntries`), NOT one row per raw `CreditLedger` row.
 * Before this, `CreditLedgerList` rendered every raw RESERVE/CAPTURE/
 * RELEASE/USAGE row belonging to a run as its own top-level row (a handful
 * of turns exploding into dozens of near-duplicate rows); this component
 * replaces it as UsageDetailedView's list. `CreditLedgerList` itself is
 * left in place (assignment §10's own raw-transaction-log surface, still
 * covered by its own tests) — just no longer this view's data source.
 */
export function UsageEntryList({
  tool,
  onViewDetails,
}: {
  tool: string;
  onViewDetails: (entry: CreditUsageEntryDTO) => void;
}) {
  const { data, isLoading, isError } = useCreditUsageEntries(tool);
  const entries = data?.entries ?? [];

  return (
    <div>
      {isLoading ? (
        <p className="p-4 text-sm text-text-secondary">Loading…</p>
      ) : isError ? (
        <p className="p-4 text-sm text-text-secondary">Couldn&apos;t load usage records.</p>
      ) : entries.length === 0 ? (
        <p className="p-4 text-sm text-text-secondary">No credit activity yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-hairline text-left text-xs font-medium uppercase text-text-secondary">
              <th className="p-4 font-medium">Credits Used</th>
              <th className="p-4 font-medium">Timestamp</th>
              <th className="p-4 text-right font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.runId}
                className="border-b border-border-hairline transition-colors last:border-b-0 hover:bg-surface-thumbnail/50"
              >
                <td className="p-4 align-middle text-sm font-bold text-text-primary">{formatCredits(Number(entry.amount))}</td>
                <td className="p-4 align-middle text-sm text-text-secondary">{formatEntryDate(entry.timestamp)}</td>
                <td className="p-4 text-right align-middle">
                  <ViewDetailsButton onClick={() => onViewDetails(entry)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
