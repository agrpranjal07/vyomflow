"use client";

import { Calendar, DollarSign, FileText, List, type LucideIcon } from "lucide-react";
import { formatCredits } from "@/lib/format";
import { formatEntryDateOnly } from "@/components/chat/credit-ledger-view";
import type { CreditUsageSummaryDTO } from "@/contracts/credits";

/**
 * 4 stat cards on /usage (credits.md "/usage full dashboard": Total
 * Debited / Records / Categories / Period). Card chrome (bordered, surface
 * background, no shadow, rounded) and label style (`text-xs font-medium
 * uppercase text-text-secondary`) are the reference's own measured classes
 * (reference-usage-page-desktop.md), mapped onto this app's existing
 * tokens — no parallel styling system. Values are the real computed
 * aggregates from the new usage-summary endpoint; Period renders an honest
 * empty state when there is no history yet, never a fabricated range.
 *
 * Icon swatch (bordered rounded square left of the label/value stack) per
 * `reference-usage-stat-cards-with-icons.png` — this card's own border/
 * radius tokens at a smaller scale, not a new one-off style. One
 * `lucide-react` icon per card (already this codebase's icon set — `Eye`/
 * `Zap`/`List` elsewhere): `DollarSign` (Total Debited), `FileText`
 * (Records), `List` (Categories), `Calendar` (Period).
 */
function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  return (
    <div className="flex min-h-20 flex-1 items-center gap-3 rounded-[var(--radius-lg)] border border-border-hairline bg-card p-4 shadow-none">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border-hairline">
        <Icon className="size-4 text-text-secondary" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase text-text-secondary">{label}</span>
        <span className="text-lg font-semibold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

export function UsageStatCards({ data, isLoading }: { data: CreditUsageSummaryDTO | undefined; isLoading: boolean }) {
  const period =
    data?.periodStart && data?.periodEnd
      ? `${formatEntryDateOnly(data.periodStart)} - ${formatEntryDateOnly(data.periodEnd)}`
      : "No activity yet";

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard
        icon={DollarSign}
        label="Total Debited"
        value={isLoading ? "—" : `${formatCredits(Number(data?.totalDebitedAll))} credits`}
      />
      <StatCard icon={FileText} label="Records" value={isLoading ? "—" : String(data?.recordsAll ?? 0)} />
      <StatCard icon={List} label="Categories" value={isLoading ? "—" : String(data?.categoriesCount ?? 0)} />
      <StatCard icon={Calendar} label="Period" value={isLoading ? "—" : period} />
    </div>
  );
}
