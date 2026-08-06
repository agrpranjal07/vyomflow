"use client";

// S7 — credit ledger list (assignment §10 "Ledger: Transaction log of all
// credit changes" row), rendered on its own /usage page (app/(chat)/usage)
// rather than in a popover dialog — the reference's own "View usage" row
// (popover captured via Claude-in-Chrome, 2026-08-21 —
// .claude/state/reference-evidence/reference-usage-page-desktop.md) is a
// real navigation, not a second popup. That capture's full "AI Credits
// Overview" dashboard (Total Debited/Records/Categories/Period stat cards,
// Show/Period filters, Overview vs. Detailed View tool-grouped table) needs
// per-tool aggregation and period-grouping data this project's backend does
// not expose (assignment §10 only requires a flat transaction log) — so
// this reuses that capture's *typography/spacing/card/table-row* system
// (verified via DOM/computed-style, not guessed) against our actual flat
// CreditLedger data, not a literal 1:1 clone of the aggregate dashboard.
import { useCreditLedger } from "@/hooks/use-credits";
import { formatCredits } from "@/lib/format";
import { CROP_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME, MERGE_VIDEOS_TOOL_NAME } from "@/contracts/tools";
import type { CreditLedgerEntryDTO } from "@/contracts/credits";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";

export const KIND_LABELS: Record<CreditLedgerEntryDTO["kind"], string> = {
  RESERVE: "Reserved",
  CAPTURE: "Captured",
  RELEASE: "Released",
  USAGE: "Usage",
};

// Mirrors backend/src/services/credits.ts's toolDisplayName exactly (same
// registered-tool constants, same fallback) — the frontend has no
// server-side import path into that file, so this is a deliberate parallel
// copy of the same mapping, not a duplicated concept invented independently.
export function toolDisplayName(toolName: string | null): string {
  if (toolName === null) return "VyomFlow";
  switch (toolName) {
    case CROP_IMAGE_TOOL_NAME:
      return "AI Crop Image";
    case GENERATE_IMAGE_TOOL_NAME:
      return "AI Generate Image";
    case MERGE_VIDEOS_TOOL_NAME:
      return "AI Merge Videos";
    default:
      return toolName
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
  }
}

// Shared "View details" outline-pill button (Overview's Action column,
// Detailed View's Details column — same reference button style, one
// source rather than two copies).
export function ViewDetailsButton({ onClick, label = "View details" }: { onClick: () => void; label?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} className="rounded-pill gap-1.5">
      <Eye className="size-3.5" />
      {label}
    </Button>
  );
}

export function formatEntryDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Date-only variant (no hour/minute) — the Period stat card's "{start} -
// {end}" range wraps onto 3 lines with a time-of-day included
// (current-usage-period-card-with-time-wraps.png); the reference shows
// "Aug 19, 2026 - Sep 18, 2026", date-only. `formatEntryDate` itself stays
// untouched — every other call site (table timestamp columns, the "Usage
// details" modal's TIMESTAMP field) correctly wants the time.
export function formatEntryDateOnly(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Row chrome — border-b + hover tint + right-aligned semibold amount — is
// the reference table row's own captured class list
// (`hover:bg-surface-secondary/50 border-b transition-colors`, amount cell
// `p-4 text-right align-middle font-semibold`), mapped onto this app's
// existing tokens (bg-surface-secondary/border-hairline already exist here).
// This list's only consumer is now UsageDetailedView's record table
// (reference-usage-detailed-view-target.png: `Credits Used | Timestamp |
// Details` columns, plain bold amount — no +/- sign, no RESERVE/CAPTURE/
// RELEASE/USAGE kind label). CreditLedger.amount is always stored
// unsigned — direction is only ever implied by `kind` — so dropping the
// sign here isn't lossy, it's the same honest number the reference shows.
// `KIND_LABELS` stays exported for usage-details-dialog.tsx's step-
// breakdown table, which still needs it.
function LedgerRow({ entry, onViewDetails }: { entry: CreditLedgerEntryDTO; onViewDetails?: (entry: CreditLedgerEntryDTO) => void }) {
  return (
    <tr className="border-b border-border-hairline transition-colors last:border-b-0 hover:bg-surface-thumbnail/50">
      <td className="p-4 align-middle text-sm font-bold text-text-primary">{formatCredits(Number(entry.amount))}</td>
      <td className="p-4 align-middle text-sm text-text-secondary">{formatEntryDate(entry.createdAt)}</td>
      <td className="p-4 text-right align-middle">{onViewDetails && <ViewDetailsButton onClick={() => onViewDetails(entry)} />}</td>
    </tr>
  );
}

/**
 * Loading/empty/error states own to this list — never a fabricated row.
 * `tool` optionally scopes the list to one tool group's toolKey (S7 /usage
 * "Detailed View" tab, usage-detailed-view.tsx) — same DTO, same rows, just
 * a server-side filtered query. No outer border/rounded wrapper here — its
 * one consumer (UsageDetailedView) already provides the single bordered
 * card (reference-usage-detailed-view-target.png shows one card, not a
 * nested pair), with its own header row above this table's `<thead>`.
 */
export function CreditLedgerList({
  tool,
  onViewDetails,
}: {
  tool?: string;
  onViewDetails?: (entry: CreditLedgerEntryDTO) => void;
} = {}) {
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useCreditLedger({ tool });
  const entries = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div>
      {isLoading ? (
        <p className="p-4 text-sm text-text-secondary">Loading…</p>
      ) : isError ? (
        <p className="p-4 text-sm text-text-secondary">Couldn&apos;t load usage history.</p>
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
              <LedgerRow key={entry.id} entry={entry} onViewDetails={onViewDetails} />
            ))}
          </tbody>
        </table>
      )}
      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full border-t border-border-hairline py-3 text-center text-sm font-medium text-text-primary hover:bg-surface-thumbnail/50 disabled:opacity-50"
        >
          {isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
