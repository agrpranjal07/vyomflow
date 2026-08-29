"use client";

import type { UsagePeriod } from "@/contracts/credits";

const PERIOD_LABELS: Record<UsagePeriod, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/**
 * /usage page's period filter (2026-08-29 — "give an option to select and
 * change period"). Scopes the stat cards, Overview table, and Detailed View
 * tab to a rolling window off the real ledger data (`?period=` on
 * usage-summary/usage-entries/usage-entries-by-chat) — no fabricated
 * "billing period" concept, just `createdAt >= now - N days`, or no lower
 * bound at all for "All time". Same bare-`<select>` styling as
 * UsageDetailedView's tool dropdown — one source for this dropdown chrome,
 * not a second one-off style.
 */
export function UsagePeriodSelect({ value, onChange }: { value: UsagePeriod; onChange: (period: UsagePeriod) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as UsagePeriod)}
      className="w-40 shrink-0 rounded-[var(--radius-sm)] border border-border-hairline bg-card px-3 py-2 text-sm text-text-primary"
      aria-label="Select period"
    >
      {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((period) => (
        <option key={period} value={period}>
          {PERIOD_LABELS[period]}
        </option>
      ))}
    </select>
  );
}
