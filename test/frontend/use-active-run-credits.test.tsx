import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useActiveRun } from "@/hooks/use-active-run";
import { creditKeys } from "@/hooks/use-credits";
import * as runsService from "@/services/runs";
import { __mockReset, __setStreamState } from "./mocks/trigger-react-hooks";
import type { AgentRunDTO, RealtimeAccess } from "@/contracts/runs";

// S7 §5.3/§9.2 T8/T9/T11 — credits invalidation must be realtime-driven
// (run finalize + deduped per-tool-terminal transition), never polling.
// Same mocking pattern as use-active-run.test.tsx (trigger-react-hooks
// controllable fake; "@/services/runs" mocked directly).

vi.mock("@/services/runs", () => ({
  getRun: vi.fn(),
  getRealtimeToken: vi.fn(),
  cancelRun: vi.fn(),
}));

function makeRun(overrides: Partial<AgentRunDTO> = {}): AgentRunDTO {
  return {
    id: "run1",
    chatId: "chat1",
    status: "running",
    userMessageId: "msg-user",
    assistantMessageId: "msg-assistant",
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    pendingWaitpoint: null,
    toolInvocations: [],
    ...overrides,
  } as AgentRunDTO;
}

function makeRealtime(overrides: Partial<RealtimeAccess> = {}): RealtimeAccess {
  return {
    runId: "run1",
    streamKey: "assistant",
    accessToken: "token1",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

function setStream(next: Parameters<typeof __setStreamState>[0]) {
  act(() => __setStreamState(next));
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  __mockReset();
  vi.mocked(runsService.getRun).mockReset();
  vi.mocked(runsService.getRealtimeToken).mockReset();
  vi.mocked(runsService.cancelRun).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function creditInvalidationCount(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(([opts]) => {
    const key = (opts as { queryKey?: readonly unknown[] } | undefined)?.queryKey;
    return Array.isArray(key) && key[0] === "credits";
  }).length;
}

describe("useActiveRun — credits invalidation (§5.3, T8/T9)", () => {
  it("finalize() invalidates creditKeys.all", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // cancel() resolving to a terminal status routes through finalize()
    // (use-active-run.ts's own cancel() callback).
    vi.mocked(runsService.cancelRun).mockResolvedValueOnce(makeRun({ status: "cancelled" }));
    await act(async () => {
      await result.current.cancel();
    });

    expect(creditInvalidationCount(spy)).toBeGreaterThanOrEqual(1);
  });

  it("invalidates exactly once per tool reaching terminal status across many deltas, and twice for two tools — not once per delta", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // Simulate a 20-delta stream for a single tool invocation, ending
    // terminal — only the final terminal delta should count.
    for (let i = 0; i < 19; i++) {
      setStream({
        parts: [{ index: i, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "RUNNING" }],
      });
    }
    setStream({
      parts: [{ index: 19, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 }],
    });
    // Re-delivering the same terminal delta again must not double-invalidate.
    setStream({
      parts: [{ index: 20, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 }],
    });

    expect(creditInvalidationCount(spy)).toBe(1);

    // A second, distinct tool reaching terminal status invalidates once more.
    setStream({
      parts: [
        { index: 19, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 },
        { index: 21, type: "tool", toolInvocationId: "t2", name: "merge_videos", status: "COMPLETED", creditUsed: 0.2 },
      ],
    });

    expect(creditInvalidationCount(spy)).toBe(2);
  });

  it("resets the per-tool dedup set on a new run via start()", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });

    act(() => result.current.start(makeRun({ id: "run1" }), makeRealtime()));
    setStream({
      parts: [{ index: 0, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 }],
    });
    expect(creditInvalidationCount(spy)).toBe(1);

    // A brand-new run reusing the same toolInvocationId (e.g. server id
    // reuse across runs is not expected, but the dedup set must not leak
    // across runs regardless) still invalidates again after start().
    act(() => result.current.start(makeRun({ id: "run2" }), makeRealtime({ runId: "run2" })));
    setStream({
      parts: [{ index: 0, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 }],
    });
    expect(creditInvalidationCount(spy)).toBe(2);
  });
});

describe("useActiveRun / useCredits — no polling (§9.2 T11)", () => {
  it("creditKeys.all is a plain query key with no refetchInterval anywhere in the credits query definition", async () => {
    const mod = await import("@/hooks/use-credits");
    expect(creditKeys.all).toEqual(["credits"]);
    // Source-level guard: use-credits.ts must not declare refetchInterval.
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(path.resolve(process.cwd(), "../frontend/src/hooks/use-credits.ts"), "utf-8");
    expect(src).not.toMatch(/refetchInterval\s*:/);
    expect(src).not.toMatch(/setInterval\s*\(/);
    expect(mod.useCredits).toBeTypeOf("function");
  });
});
