/**
 * Shared numeric-display formatters. `formatCredits` was previously
 * duplicated — private to tool-card.tsx and re-implemented inline in
 * message-content.tsx (S7 §6.2 "repeated UI value → single authoritative
 * source"). One function, every credit-displaying surface imports it.
 */
export function formatCredits(credits: number | null | undefined): string {
  return `${(credits ?? 0).toFixed(2)}M`;
}
