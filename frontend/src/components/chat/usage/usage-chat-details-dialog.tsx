"use client";

import { List } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCredits } from "@/lib/format";
import { formatEntryDate, toolDisplayName } from "@/components/chat/credit-ledger-view";
import { useCreditLedgerByChat } from "@/hooks/use-credits";
import type { CreditUsageChatEntryDTO } from "@/contracts/credits";

/**
 * "VyomFlow" aggregate row's Details drill-down (2026-08-29 UX fix) —
 * UsageChatBreakdownList's per-chat row nets every tool/run in that chat
 * into one amount, so there's no single runId for UsageDetailsDialog's
 * run-scoped step breakdown to key off of. This lists that chat's spend
 * back out one row per (tool, run) instead, same Field-grid-plus-table
 * shell as UsageDetailsDialog — a new dialog rather than reusing that one,
 * since the two are keyed by different ids (runId vs. chatId) and mixing
 * them would need an awkward union prop.
 */
export function UsageChatDetailsDialog({
  entry,
  onOpenChange,
}: {
  entry: CreditUsageChatEntryDTO | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, isError } = useCreditLedgerByChat(entry?.chatId ?? null);

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <List className="size-4" />
            Usage details
          </DialogTitle>
        </DialogHeader>
        {entry && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 rounded-[var(--radius-lg)] border border-border-hairline p-4 sm:grid-cols-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium uppercase text-text-secondary">Chat</span>
                <span className="truncate text-sm text-text-primary">{entry.chatTitle}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium uppercase text-text-secondary">Total credits</span>
                <span className="truncate text-sm font-bold text-text-primary">{formatCredits(Number(entry.amount))}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium uppercase text-text-secondary">Timestamp</span>
                <span className="truncate text-sm text-text-primary">{formatEntryDate(entry.timestamp)}</span>
              </div>
            </div>

            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Run breakdown</h3>
                  <p className="text-xs text-text-secondary">Every tool/run that spent credits in this chat</p>
                </div>
                <span className="shrink-0 rounded-pill border border-border-hairline px-2.5 py-1 text-xs font-medium text-text-secondary">
                  {isLoading ? "…" : `${data?.items.length ?? 0} runs`}
                </span>
              </div>
              <div className="mt-3 overflow-hidden rounded-[var(--radius-lg)] border border-border-hairline">
                {isLoading ? (
                  <p className="p-4 text-sm text-text-secondary">Loading…</p>
                ) : isError ? (
                  <p className="p-4 text-sm text-text-secondary">Couldn&apos;t load run breakdown.</p>
                ) : !data || data.items.length === 0 ? (
                  <p className="p-4 text-sm text-text-secondary">No runs recorded for this chat.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-hairline text-left text-xs font-medium uppercase text-text-secondary">
                        <th className="p-3 font-medium">Run</th>
                        <th className="p-3 font-medium">Timestamp</th>
                        <th className="p-3 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.runId} className="border-b border-border-hairline last:border-b-0">
                          <td className="p-3 text-text-primary">{toolDisplayName(item.toolName)}</td>
                          <td className="p-3 text-text-secondary">{formatEntryDate(item.timestamp)}</td>
                          <td className="p-3 text-right font-medium text-text-primary">{formatCredits(Number(item.amount))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
