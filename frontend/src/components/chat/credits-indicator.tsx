"use client";

import Link from "next/link";
import { Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useCredits } from "@/hooks/use-credits";
import { formatCredits } from "@/lib/format";

/**
 * Top-right credits pill + popover (S7 §5.2/§6.2). Every color/spacing/
 * radius value below is taken from .claude/evidence/credits.md's measured
 * DOM/computed-style capture against the live reference, mapped onto this
 * app's own existing tokens (never a parallel token system):
 *   pill:    text-primary / bg-background / border-secondary / rounded-pill
 *   popover: bg-card (== bg-popover) / rounded-sm (closest existing token —
 *            measured 12px vs. our --radius-sm's 10px; --radius-md is 16px,
 *            further off. A small, honest 2px divergence, not a new token
 *            for one component.)
 * Labels ("MONTHLY PLAN" / "Available Credits") render in full text-primary,
 * not a muted tone — a measured surprise, see credits.md. The "{held}M
 * held" sub-line is OUR addition (not in the reference) and is deliberately
 * muted (text-secondary) to visually distinguish it from the reference's
 * own non-muted labels.
 *
 * Trigger opens on hover, not click — re-verified live 2026-08-21 (credits.md
 * "Header pill popover" section): a plain mouse hover opens the reference
 * popover with zero clicks. `CLOSE_DELAY_MS` is a standard hover-menu
 * grace period (not a measured visual value) so the popover doesn't vanish
 * while the pointer travels from the pill to the popover content.
 */
const CLOSE_DELAY_MS = 150;

export function CreditsIndicator() {
  const { data, isLoading, isError } = useCredits();

  if (isLoading) {
    return <Skeleton className="h-[28px] w-[74px] rounded-pill" />;
  }

  // No fabricated balance on error — omit the pill entirely rather than
  // show a fake "0.00M" (T7).
  if (isError || !data) return null;

  const available = formatCredits(Number(data.available));
  const held = Number(data.held);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        closeDelay={CLOSE_DELAY_MS}
        className="flex items-center gap-2 rounded-pill border border-border-secondary bg-background px-3 py-1 text-sm text-text-primary"
        aria-label={`Credits available: ${available}. Plan details.`}
      >
        <Zap className="size-3.5" />
        {available}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[255px] rounded-sm bg-card p-3 text-text-primary shadow-none">
        <p className="text-xs leading-4 text-text-primary">MONTHLY PLAN</p>
        <p className="mt-2 text-xs leading-4 text-text-primary">Available Credits</p>
        <p className="text-base font-bold leading-6 text-text-primary">{available}</p>
        {held > 0 && <p className="mt-1 text-xs leading-4 text-text-secondary">{formatCredits(held)} held</p>}
        {/* Real navigation, not a second popup — reference's own "View
            usage" row inside this same popover navigates to a standalone
            /usage page (verified via Claude-in-Chrome, see
            .claude/state/reference-evidence/reference-usage-page-desktop.md). */}
        <Link
          href="/usage"
          className="mt-2 inline-block text-xs font-medium leading-4 text-text-primary underline underline-offset-2"
        >
          View usage
        </Link>
      </PopoverContent>
    </Popover>
  );
}
