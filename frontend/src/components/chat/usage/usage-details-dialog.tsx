"use client";

import { List } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCredits } from "@/lib/format";
import { formatEntryDate, KIND_LABELS, toolDisplayName } from "@/components/chat/credit-ledger-view";
import { useCreditLedgerByRun } from "@/hooks/use-credits";
import type { CreditRunStepsDTO, CreditUsageEntryDTO, CreditUsageGroupDTO } from "@/contracts/credits";

export interface UsageDetailsRecord {
  // The netted usage-entry row that was clicked (UsageEntryList /
  // CreditUsageEntryDTO — `amount`/`timestamp` are that run's already-
  // netted CAPTURE/USAGE total, not one raw ledger row's own amount).
  entry: CreditUsageEntryDTO;
  group: CreditUsageGroupDTO;
}

function Field({ label, value, mono, bold }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium uppercase text-text-secondary">{label}</span>
      <span className={`truncate text-sm text-text-primary ${mono ? "font-mono" : ""} ${bold ? "font-bold" : ""}`}>{value}</span>
    </div>
  );
}

/**
 * Presentational body — no Dialog primitive dependency, so it renders
 * safely in this workspace's jsdom test environment (base-ui Dialog isn't
 * safely renderable there; test/frontend's existing Dialog-using
 * components are either mocked out or, like this one, split so the content
 * can be tested standalone). `record.entry`/`record.group` are the
 * selected ledger row and its tool group (for MODEL — the same tool-
 * display-name string already shown for that grouping, deliberately not
 * AgentRun.requestedModel/resolvedModel, per credits.md's drill-down-gap
 * note). `data` is the runId-scoped step breakdown from
 * useCreditLedgerByRun.
 */
export function UsageDetailsDialogBody({
  record,
  data,
  isLoading,
  isError,
}: {
  record: UsageDetailsRecord;
  data: CreditRunStepsDTO | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const { entry, group } = record;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 rounded-[var(--radius-lg)] border border-border-hairline p-4 sm:grid-cols-4">
        <Field label="Chat" value={data?.chatId ?? "—"} mono />
        <Field label="Model" value={group.displayName} />
        <Field label="Total credits" value={formatCredits(Number(entry.amount))} bold />
        <Field label="Timestamp" value={formatEntryDate(entry.timestamp)} />
      </div>

      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Step breakdown</h3>
            <p className="text-xs text-text-secondary">Execution costs recorded for this usage entry</p>
          </div>
          <span className="shrink-0 rounded-pill border border-border-hairline px-2.5 py-1 text-xs font-medium text-text-secondary">
            {isLoading ? "…" : `${data?.items.length ?? 0} steps`}
          </span>
        </div>
        <div className="mt-3 overflow-hidden rounded-[var(--radius-lg)] border border-border-hairline">
          {isLoading ? (
            <p className="p-4 text-sm text-text-secondary">Loading…</p>
          ) : isError ? (
            <p className="p-4 text-sm text-text-secondary">Couldn&apos;t load step breakdown.</p>
          ) : !data || data.items.length === 0 ? (
            <p className="p-4 text-sm text-text-secondary">No steps recorded for this entry.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-hairline text-left text-xs font-medium uppercase text-text-secondary">
                  <th className="p-3 font-medium">Step</th>
                  <th className="p-3 font-medium">Timestamp</th>
                  <th className="p-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((step) => (
                  <tr key={step.id} className="border-b border-border-hairline last:border-b-0">
                    <td className="p-3 text-text-primary">
                      {step.toolName ? `${toolDisplayName(step.toolName)} — ${KIND_LABELS[step.kind]}` : KIND_LABELS[step.kind]}
                    </td>
                    <td className="p-3 text-text-secondary">{formatEntryDate(step.createdAt)}</td>
                    <td className="p-3 text-right font-medium text-text-primary">{formatCredits(Number(step.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export function UsageDetailsDialog({
  record,
  onOpenChange,
}: {
  record: UsageDetailsRecord | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, isError } = useCreditLedgerByRun(record?.entry.runId ?? null);
  return (
    <Dialog open={record !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <List className="size-4" />
            Usage details
          </DialogTitle>
        </DialogHeader>
        {record && <UsageDetailsDialogBody record={record} data={data} isLoading={isLoading} isError={isError} />}
      </DialogContent>
    </Dialog>
  );
}
