import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useSendTurn } from "@/hooks/use-send-turn";
import { ApiError } from "@/lib/api-client";
import * as runsService from "@/services/runs";
import type { SendTurnResponse } from "@/contracts/runs";

// Policy under test: plan §6.3 / §4.1 — INSUFFICIENT_CREDITS 402s were
// previously swallowed (no onError at all), leaving the user with no
// feedback. Closes that defect (T10 in the S7 plan).

vi.mock("@/services/runs", () => ({
  sendTurn: vi.fn(),
}));

// "sonner" resolves to test/frontend/mocks/sonner.tsx via the vitest.frontend.config.mts
// alias (same mechanism as @clerk/nextjs / @trigger.dev/react-hooks) — no vi.mock needed.

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={makeClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSendTurn — insufficient-credits surfacing (§4.1)", () => {
  it("surfaces a 402 INSUFFICIENT_CREDITS error via a Sonner toast with the backend message verbatim", async () => {
    const message = "Insufficient credits to start this response.";
    vi.mocked(runsService.sendTurn).mockRejectedValue(new ApiError(402, "INSUFFICIENT_CREDITS", message));

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(message);
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

  it("does not toast for other error codes (scoped to the 402 only)", async () => {
    vi.mocked(runsService.sendTurn).mockRejectedValue(new ApiError(500, "INTERNAL", "boom"));

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("keeps the existing onSuccess behavior unaffected", async () => {
    const response = { chatId: "chat1" } as unknown as SendTurnResponse;
    vi.mocked(runsService.sendTurn).mockResolvedValue(response);

    const { result } = renderHook(() => useSendTurn("chat1"), { wrapper });

    await act(async () => {
      result.current.mutate({ text: "hello", attachmentIds: [] });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
