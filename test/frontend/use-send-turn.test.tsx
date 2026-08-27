import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, screen } from "@testing-library/react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSendTurn } from "@/hooks/use-send-turn";
import { ApiError } from "@/lib/api-client";
import * as runsService from "@/services/runs";
import type { SendTurnResponse } from "@/contracts/runs";
import { CreditPaywallProvider } from "@/components/credits/paywall-provider";
import { useCredits } from "@/hooks/use-credits";

// Policy under test: plan §4.1/§Implementation-3 — INSUFFICIENT_CREDITS 402s
// were previously swallowed by a toast; the app-wide reusable paywall must
// open instead (T10 in the original S7 plan, superseded by the credit-
// paywall plan).

vi.mock("@/services/runs", () => ({
  sendTurn: vi.fn(),
}));
// @base-ui/react's Dialog isn't safely renderable in this workspace's RTL
// environment — see mocks/ui-dialog.tsx's header comment.
vi.mock("@/components/ui/dialog", () => import("./mocks/ui-dialog"));
vi.mock("@/hooks/use-credits", () => ({ useCredits: vi.fn(), creditKeys: { all: ["credits"] } }));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <CreditPaywallProvider>{children}</CreditPaywallProvider>
      </QueryClientProvider>
    );
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return wrapperFor(makeClient())({ children });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCredits).mockReturnValue({
    data: { balance: "0", held: "0", available: "0" },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useCredits>);
});

describe("useSendTurn — insufficient-credits surfacing", () => {
  it("opens the credit paywall dialog on a 402 INSUFFICIENT_CREDITS error", async () => {
    const message = "Insufficient credits to start this response.";
    vi.mocked(runsService.sendTurn).mockRejectedValue(new ApiError(402, "INSUFFICIENT_CREDITS", message));

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(await screen.findByText("Out of credits")).toBeInTheDocument();
  });

  it("invalidates the credits query on a 402 so the pill reflects the balance that caused it", async () => {
    const message = "Insufficient credits to start this response.";
    vi.mocked(runsService.sendTurn).mockRejectedValue(new ApiError(402, "INSUFFICIENT_CREDITS", message));

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper: wrapperFor(client) });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["credits"] });
  });

  it("does not open the paywall for other error codes (scoped to 402/INSUFFICIENT_CREDITS only)", async () => {
    vi.mocked(runsService.sendTurn).mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(screen.queryByText("Out of credits")).not.toBeInTheDocument();
  });

  it("keeps the existing onSuccess behavior unaffected", async () => {
    const response = { chatId: "chat1" } as unknown as SendTurnResponse;
    vi.mocked(runsService.sendTurn).mockResolvedValue(response);

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(screen.queryByText("Out of credits")).not.toBeInTheDocument();
  });
});
