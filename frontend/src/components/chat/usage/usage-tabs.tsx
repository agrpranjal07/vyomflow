"use client";

export type UsageTab = "overview" | "detailed";

const TABS: Array<{ id: UsageTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "detailed", label: "Detailed View" },
];

/**
 * Pill-style segmented tab switcher (reference: rounded-radius-max pill
 * buttons, active state gets a raised surface + shadow — measured classes
 * in reference-usage-page-desktop.md), mapped onto this app's own
 * rounded-pill/bg-card tokens.
 */
export function UsageTabs({ active, onChange }: { active: UsageTab; onChange: (tab: UsageTab) => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-pill border border-border-hairline bg-muted p-1">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          aria-pressed={active === tab.id}
          // Reference's own captured classes (reference-usage-page-desktop.md):
          // rounded-radius-max / px-space-04 / text-small font-regular
          // leading-5 → our rounded-pill / px-6 / text-sm font-normal
          // leading-5. Widened from px-4 to px-6 and dropped font-medium to
          // font-normal to match "font-regular" — the earlier px-4/
          // font-medium guess undershot both.
          className={`rounded-pill px-6 py-2 text-sm font-normal leading-5 transition-colors ${
            active === tab.id
              ? "bg-card text-text-primary shadow-sm"
              : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
