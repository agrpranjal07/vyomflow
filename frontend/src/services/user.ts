import type { Fetcher } from "@/lib/api-client";
import {
  CreditBalanceDTOSchema,
  CreditRunStepsDTOSchema,
  CreditUsageSummaryDTOSchema,
  ListCreditLedgerResponseSchema,
  ListCreditUsageEntriesResponseSchema,
  type CreditBalanceDTO,
  type CreditRunStepsDTO,
  type CreditUsageSummaryDTO,
  type ListCreditLedgerResponse,
  type ListCreditUsageEntriesResponse,
} from "@/contracts/credits";

export async function getCredits(fetcher: Fetcher): Promise<CreditBalanceDTO> {
  const raw = await fetcher("/api/v1/me/credits");
  return CreditBalanceDTOSchema.parse(raw);
}

export async function getCreditLedger(
  fetcher: Fetcher,
  cursor?: string,
  tool?: string,
): Promise<ListCreditLedgerResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (tool) params.set("tool", tool);
  const raw = await fetcher(`/api/v1/me/credits/ledger?${params.toString()}`);
  return ListCreditLedgerResponseSchema.parse(raw);
}

export async function getCreditUsageSummary(fetcher: Fetcher): Promise<CreditUsageSummaryDTO> {
  const raw = await fetcher("/api/v1/me/credits/usage-summary");
  return CreditUsageSummaryDTOSchema.parse(raw);
}

export async function getCreditLedgerByRun(fetcher: Fetcher, runId: string): Promise<CreditRunStepsDTO> {
  const raw = await fetcher(`/api/v1/me/credits/ledger/run/${encodeURIComponent(runId)}`);
  return CreditRunStepsDTOSchema.parse(raw);
}

export async function getCreditUsageEntries(fetcher: Fetcher, tool: string): Promise<ListCreditUsageEntriesResponse> {
  const raw = await fetcher(`/api/v1/me/credits/usage-entries?tool=${encodeURIComponent(tool)}`);
  return ListCreditUsageEntriesResponseSchema.parse(raw);
}
