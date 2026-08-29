import type { Fetcher } from "@/lib/api-client";
import {
  CreditBalanceDTOSchema,
  CreditChatRunsDTOSchema,
  CreditRunStepsDTOSchema,
  CreditUsageSummaryDTOSchema,
  ListCreditLedgerResponseSchema,
  ListCreditUsageEntriesResponseSchema,
  ListCreditUsageChatEntriesResponseSchema,
  type CreditBalanceDTO,
  type CreditChatRunsDTO,
  type CreditRunStepsDTO,
  type CreditUsageSummaryDTO,
  type ListCreditLedgerResponse,
  type ListCreditUsageEntriesResponse,
  type ListCreditUsageChatEntriesResponse,
  type UsagePeriod,
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

export async function getCreditUsageSummary(fetcher: Fetcher, period: UsagePeriod = "all"): Promise<CreditUsageSummaryDTO> {
  const raw = await fetcher(`/api/v1/me/credits/usage-summary?period=${period}`);
  return CreditUsageSummaryDTOSchema.parse(raw);
}

export async function getCreditLedgerByRun(fetcher: Fetcher, runId: string): Promise<CreditRunStepsDTO> {
  const raw = await fetcher(`/api/v1/me/credits/ledger/run/${encodeURIComponent(runId)}`);
  return CreditRunStepsDTOSchema.parse(raw);
}

export async function getCreditUsageEntries(
  fetcher: Fetcher,
  tool: string,
  period: UsagePeriod = "all",
): Promise<ListCreditUsageEntriesResponse> {
  const raw = await fetcher(`/api/v1/me/credits/usage-entries?tool=${encodeURIComponent(tool)}&period=${period}`);
  return ListCreditUsageEntriesResponseSchema.parse(raw);
}

export async function getCreditUsageEntriesByChat(
  fetcher: Fetcher,
  period: UsagePeriod = "all",
): Promise<ListCreditUsageChatEntriesResponse> {
  const raw = await fetcher(`/api/v1/me/credits/usage-entries-by-chat?period=${period}`);
  return ListCreditUsageChatEntriesResponseSchema.parse(raw);
}

export async function getCreditLedgerByChat(fetcher: Fetcher, chatId: string): Promise<CreditChatRunsDTO> {
  const raw = await fetcher(`/api/v1/me/credits/ledger/chat/${encodeURIComponent(chatId)}`);
  return CreditChatRunsDTOSchema.parse(raw);
}
