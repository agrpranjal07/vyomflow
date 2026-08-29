"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import * as userService from "@/services/user";
import type { UsagePeriod } from "@/contracts/credits";

export const creditKeys = {
  all: ["credits"] as const,
  ledger: ["credits", "ledger"] as const,
  ledgerByTool: (tool: string) => ["credits", "ledger", tool] as const,
  usageSummary: (period: UsagePeriod) => ["credits", "usage-summary", period] as const,
  ledgerByRun: (runId: string) => ["credits", "ledger", "run", runId] as const,
  usageEntries: (tool: string, period: UsagePeriod) => ["credits", "usage-entries", tool, period] as const,
  usageEntriesByChat: (period: UsagePeriod) => ["credits", "usage-entries-by-chat", period] as const,
  ledgerByChat: (chatId: string) => ["credits", "ledger", "chat", chatId] as const,
};

// Realtime-driven invalidation (use-active-run.ts's finalize()/per-tool
// terminal transitions) is the live-update path — this staleTime just
// bounds incidental refetches, it is not a polling substitute
// (realtime-transport-policy.md). No refetchInterval here, ever.
const CREDITS_STALE_TIME_MS = 30_000;

export function useCredits() {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.all,
    queryFn: () => userService.getCredits(fetcher),
    staleTime: CREDITS_STALE_TIME_MS,
  });
}

// S7 — ledger read (assignment §10 "Ledger" row). Same cursor-pagination
// idiom as use-chats.ts's useChatsList — rendered on the standalone /usage
// page, not a live-updating surface, so no realtime wiring here. `enabled`
// stays overridable for callers that mount the list before it's visible.
export function useCreditLedger(options: { enabled?: boolean; tool?: string } = {}) {
  const fetcher = useApiClient();
  return useInfiniteQuery({
    queryKey: options.tool ? creditKeys.ledgerByTool(options.tool) : creditKeys.ledger,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      userService.getCreditLedger(fetcher, pageParam, options.tool),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

// S7 — /usage dashboard stat cards + Overview table (credits.md "/usage
// full dashboard"). Not a live-updating surface, same posture as
// useCreditLedger — no realtime wiring, no polling.
export function useCreditUsageSummary(period: UsagePeriod = "all") {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.usageSummary(period),
    queryFn: () => userService.getCreditUsageSummary(fetcher, period),
    staleTime: CREDITS_STALE_TIME_MS,
  });
}

// S7 — "Usage details" modal step breakdown (credits.md "`/usage` —
// Action/'View details' drill-down gap"). `enabled` defaults to whether a
// runId is present so the dialog's query only fires once a record is
// actually selected — never fetched speculatively for every row.
export function useCreditLedgerByRun(runId: string | null) {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.ledgerByRun(runId ?? ""),
    queryFn: () => userService.getCreditLedgerByRun(fetcher, runId as string),
    enabled: runId !== null,
    staleTime: CREDITS_STALE_TIME_MS,
  });
}

// S7 — Detailed View tab's netted per-run record list (credits.md "`/usage`
// — Action/'View details' drill-down gap", netted-rows fold-in). One row
// per run within the selected tool bucket, not one per raw ledger row —
// see backend/src/services/credits.ts's listUsageEntries.
export function useCreditUsageEntries(tool: string | undefined, period: UsagePeriod = "all") {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.usageEntries(tool ?? "", period),
    queryFn: () => userService.getCreditUsageEntries(fetcher, tool as string, period),
    enabled: tool !== undefined,
    staleTime: CREDITS_STALE_TIME_MS,
  });
}

// S7 — Detailed View tab's "VyomFlow" aggregate group (2026-08-29 UX fix).
// Netted per-chat across every tool + bare-LLM usage combined — see
// backend/src/services/credits.ts's listUsageEntriesByChat. Only mounted
// when that group is selected (UsageChatBreakdownList), so no `enabled`
// gate is needed here the way useCreditUsageEntries needs one for its
// optional `tool`.
export function useCreditUsageEntriesByChat(period: UsagePeriod = "all") {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.usageEntriesByChat(period),
    queryFn: () => userService.getCreditUsageEntriesByChat(fetcher, period),
    staleTime: CREDITS_STALE_TIME_MS,
  });
}

// "VyomFlow" aggregate row's Details drill-down (2026-08-29) — one row per
// (tool, run) within the clicked chat, mirroring useCreditLedgerByRun's
// `enabled`-gated-by-id shape since it's only fetched once a chat row is
// selected in UsageChatDetailsDialog.
export function useCreditLedgerByChat(chatId: string | null) {
  const fetcher = useApiClient();
  return useQuery({
    queryKey: creditKeys.ledgerByChat(chatId ?? ""),
    queryFn: () => userService.getCreditLedgerByChat(fetcher, chatId as string),
    enabled: chatId !== null,
    staleTime: CREDITS_STALE_TIME_MS,
  });
}
