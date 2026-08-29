"use client";

import { formatCredits } from "@/lib/format";
import { formatEntryDate, ViewDetailsButton } from "@/components/chat/credit-ledger-view";
import { useCreditUsageEntriesByChat } from "@/hooks/use-credits";
import type { CreditUsageChatEntryDTO, UsagePeriod } from "@/contracts/credits";

/**
 * Detailed View tab's record table for the "VyomFlow" aggregate group
 * (2026-08-29 UX fix) — one row per chat, netted across every tool + bare-LLM
 * usage combined (backend's `listUsageEntriesByChat`), not one row per run
 * within a single tool bucket the way `UsageEntryList` renders for every
 * other group. Selecting the whole-product total and then seeing per-run
 * rows scoped to no particular tool was the confusing signal being fixed —
 * "where did my credits go" is answered per chat here instead. Details opens
 * UsageChatDetailsDialog (one row per tool/run within that chat), the same
 * ViewDetailsButton every other group's table uses — not a link that
 * navigates away, since every other Details action stays on this page too.
 */
export function UsageChatBreakdownList({
  period,
  onViewDetails,
}: {
  period: UsagePeriod;
  onViewDetails: (entry: CreditUsageChatEntryDTO) => void;
}) {
  const { data, isLoading, isError } = useCreditUsageEntriesByChat(period);
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
                key={entry.chatId}
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
