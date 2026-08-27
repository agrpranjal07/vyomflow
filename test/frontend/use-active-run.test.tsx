import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useActiveRun } from "@/hooks/use-active-run";
import * as runsService from "@/services/runs";
import { CreditPaywallProvider } from "@/components/credits/paywall-provider";

// useActiveRun only needs useCreditPaywall()'s context to be present here —
// these tests don't exercise the dialog's own rendering (see
// credit-paywall-dialog.test.tsx for that), so stub it out rather than pull
// in @base-ui/react's Dialog (not safely renderable in this workspace's RTL
// environment, mocks/ui-dialog.tsx) and a real useCredits() fetch.
vi.mock("@/components/credits/credit-paywall-dialog", () => ({
  CreditPaywallDialog: () => null,
}));
import {
  __mockReset,
  __setStreamState,
  __setRunState,
  __latestStreamCall,
  __getStreamCalls,
} from "./mocks/trigger-react-hooks";
import type { AgentRunDTO, RealtimeAccess } from "@/contracts/runs";

// Policy under test: ../../.claude/rules/realtime-transport-policy.md. The
// hook's own constants (mirrored here, not re-imported — they're module-
// private) — see use-active-run.ts's own top-of-file comment block for the
// authoritative values/rationale.
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const STREAM_STALE_MS = 20_000;
const TOOL_STREAM_STALE_MS = 6 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const CONNECTION_LOST_POLL_MS = 60_000;
const TOKEN_REFRESH_MIN_DELAY_MS = 3_000;

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
    lastStreamIndex: -1,
    cancelRequestedAt: null,
    requestedModel: "openrouter/free-model",
    resolvedModel: "openrouter/free-model",
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: null,
    toolInvocations: [],
    totalCreditsUsed: 0,
    ...overrides,
  };
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <CreditPaywallProvider>{children}</CreditPaywallProvider>
    </QueryClientProvider>
  );
}

/**
 * Advances fake timers and flushes the resulting promise microtasks (REST
 * calls, forceResubscribe's setTimeout(0)) within an act() so React state
 * updates settle before the next assertion. The trailing zero-advance
 * catches a watchdog-effect restart whose own near-zero setTimeout got
 * registered only as the *last* thing this act() flush did — React's effect
 * commit for that restart can land after `advanceTimersByTimeAsync`'s own
 * due-timer loop already stopped checking, leaving that freshly-scheduled
 * timer pending for one extra flush rather than firing within this call.
 */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function setStream(next: Parameters<typeof __setStreamState>[0]) {
  act(() => __setStreamState(next));
}

function setRunStatus(next: Parameters<typeof __setRunState>[0]) {
  act(() => __setRunState(next));
}

beforeEach(() => {
  __mockReset();
  vi.mocked(runsService.getRun).mockReset();
  vi.mocked(runsService.getRealtimeToken).mockReset();
  vi.mocked(runsService.cancelRun).mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useActiveRun — disconnect detection", () => {
  it("a stable-identity SDK error object is handled once, then does not re-trigger reconnect on later ticks", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // First watchdog tick: healthy, no error, no stall.
    await tick(WATCHDOG_INTERVAL_MS);
    expect(result.current.isReconnecting).toBe(false);

    const err1 = new Error("stream disconnected");
    setStream({ error: err1 });
    await tick(WATCHDOG_INTERVAL_MS);
    // Reconnect handling ran for err1: a REST call + forceResubscribe.
    expect(runsService.getRun).toHaveBeenCalled();
    const callsAfterErr1 = vi.mocked(runsService.getRun).mock.calls.length;

    // Next tick, same `err1` reference still sitting on the SDK's error cell
    // (never cleared by the SDK itself) — must NOT be treated as a fresh
    // failure again.
    await tick(RECONNECT_BACKOFF_MS[0]);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAfterErr1);
    expect(result.current.isReconnecting).toBe(false);

    // A genuinely new error object reference DOES trigger reconnect again.
    const err2 = new Error("stream disconnected again");
    setStream({ error: err2 });
    await tick(WATCHDOG_INTERVAL_MS);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBeGreaterThan(callsAfterErr1);
  });

  it("a stall with zero stream parts delivered for STREAM_STALE_MS triggers the watchdog with no explicit SDK error", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    await tick(STREAM_STALE_MS);
    expect(runsService.getRun).toHaveBeenCalled();
    expect(result.current.isReconnecting).toBe(true);
  });

  it("while a tool is DISPATCHING, the watchdog tolerates STREAM_STALE_MS of silence and only stalls past the longer TOOL_STREAM_STALE_MS", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // A DISPATCHING tool part arrives — counts as activity (resets the
    // staleness clock) and marks a tool as in-flight for the watchdog's
    // dynamic threshold.
    setStream({
      parts: [{ index: 0, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "DISPATCHING" }],
    });

    // Well past the normal STREAM_STALE_MS, still well under the tool
    // threshold — must NOT have triggered reconnect handling yet.
    await tick(STREAM_STALE_MS + WATCHDOG_INTERVAL_MS);
    expect(runsService.getRun).not.toHaveBeenCalled();
    expect(result.current.isReconnecting).toBe(false);

    // Advance the remainder to cross TOOL_STREAM_STALE_MS from the part's
    // arrival — now it must stall and trigger reconnect handling. Not
    // asserting `isReconnecting` stays true afterward: `forceResubscribe`
    // deliberately stamps `lastActivityAt` on every attempt (use-active-
    // run.ts's own watchdog effect), so once the resubscribe fires the
    // watchdog correctly finds nothing stale *yet* and clears the flag
    // again within this same settling window — the durable signal that
    // the stall was actually detected and acted on is the REST call itself.
    await tick(TOOL_STREAM_STALE_MS - (STREAM_STALE_MS + WATCHDOG_INTERVAL_MS) + WATCHDOG_INTERVAL_MS);
    expect(runsService.getRun).toHaveBeenCalled();
  });
});

describe("useActiveRun — bounded reconnection", () => {
  it("follows the exact RECONNECT_BACKOFF_MS schedule attempt-by-attempt, then sets connectionLost on the 6th consecutive failure", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // Consecutive failures: a fresh error reference before each check
    // simulates a resubscribed connection that immediately fails again.
    setStream({ error: new Error("fail-0") });
    await tick(WATCHDOG_INTERVAL_MS); // attempt 1 scheduled (delay = RECONNECT_BACKOFF_MS[0])
    expect(result.current.connectionLost).toBe(false);

    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      setStream({ error: new Error(`fail-${i + 1}`) });
      await tick(RECONNECT_BACKOFF_MS[i]);
      console.log(`[dbg] i=${i} connectionLost=${result.current.connectionLost} isReconnecting=${result.current.isReconnecting} calls=${vi.mocked(runsService.getRun).mock.calls.length}`);
    }

    // 6 consecutive failures (the initial trigger + 5 backoff attempts)
    // exhaust RECONNECT_BACKOFF_MS.length attempts — connectionLost now set,
    // no more resubscribe attempts.
    expect(result.current.connectionLost).toBe(true);
    const callsAtExhaustion = vi.mocked(runsService.getRun).mock.calls.length;

    // A further tick at the (now slow) poll cadence must not add a
    // RECONNECT_BACKOFF_MS-paced call.
    await tick(RECONNECT_BACKOFF_MS[0]);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAtExhaustion);
  });

  it("toggling `enabled` mid-backoff (forceResubscribe's own suspend/resume) does not truncate the already-scheduled deadline", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    setStream({ error: new Error("fail-0") });
    await tick(WATCHDOG_INTERVAL_MS);
    const callsAfterFirstFailure = vi.mocked(runsService.getRun).mock.calls.length;

    // forceResubscribe's own enabled-toggle (triggered by the failure above)
    // restarts the watchdog effect. If nextAttemptAtRef weren't carried
    // across that restart, the effect would reschedule from
    // WATCHDOG_INTERVAL_MS again instead of preserving the backoff delay —
    // advancing by less than RECONNECT_BACKOFF_MS[0] must NOT fire another
    // attempt early.
    await tick(RECONNECT_BACKOFF_MS[0] - 500);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAfterFirstFailure);

    // Crossing the real deadline does fire it.
    setStream({ error: new Error("fail-1") });
    await tick(500);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBeGreaterThan(callsAfterFirstFailure);
  });
});

describe("useActiveRun — token refresh", () => {
  it("schedules the refresh at expiresAt - TOKEN_REFRESH_MARGIN_MS", async () => {
    vi.mocked(runsService.getRealtimeToken).mockResolvedValue(makeRealtime({ accessToken: "refreshed-token" }));
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    const expiresInMs = 5 * 60_000;
    act(() => result.current.start(makeRun(), makeRealtime({ expiresAt: new Date(Date.now() + expiresInMs).toISOString() })));

    await tick(expiresInMs - TOKEN_REFRESH_MARGIN_MS - 500);
    expect(runsService.getRealtimeToken).not.toHaveBeenCalled();

    await tick(500);
    expect(runsService.getRealtimeToken).toHaveBeenCalledTimes(1);
  });

  it("floors an already-past-margin expiry to TOKEN_REFRESH_MIN_DELAY_MS instead of firing in a tight loop", async () => {
    vi.mocked(runsService.getRealtimeToken).mockResolvedValue(makeRealtime({ accessToken: "refreshed-token" }));
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    // Already expired relative to the margin — msUntilRefresh is negative.
    act(() => result.current.start(makeRun(), makeRealtime({ expiresAt: new Date(Date.now() - 10_000).toISOString() })));

    await tick(TOKEN_REFRESH_MIN_DELAY_MS - 500);
    expect(runsService.getRealtimeToken).not.toHaveBeenCalled();

    await tick(500);
    expect(runsService.getRealtimeToken).toHaveBeenCalledTimes(1);
  });
});

describe("useActiveRun — resume wiring", () => {
  it("passes computeStartIndex(run)'s actual return value as useRealtimeStream's startIndex", () => {
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun({ lastStreamIndex: 7 }), makeRealtime()));

    const call = __latestStreamCall();
    expect(call.options.startIndex).toBe(8); // computeStartIndex: lastStreamIndex + 1
  });
});

describe("useActiveRun — duplicate prevention (end-to-end)", () => {
  it("an overlapping index range redelivered across a resubscribe does not duplicate accumulated text", () => {
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    setStream({
      parts: [
        { index: 0, type: "text", delta: "Hello " },
        { index: 1, type: "text", delta: "World" },
      ],
    });
    expect(result.current.streamedText).toBe("Hello World");

    // The SDK's own SWR cache concatenates rather than dedupes — a
    // resubscribe redelivering index 1 appends it again verbatim.
    setStream({
      parts: [
        { index: 0, type: "text", delta: "Hello " },
        { index: 1, type: "text", delta: "World" },
        { index: 1, type: "text", delta: "World" },
        { index: 2, type: "text", delta: "!" },
      ],
    });
    expect(result.current.streamedText).toBe("Hello World!");
  });
});

describe("useActiveRun — gap prevention", () => {
  it("resumes from the REST-corrected index after a disconnect and picks up parts that were in-flight during the outage, skipping nothing", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun({ lastStreamIndex: 1 }));
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    setStream({
      parts: [
        { index: 0, type: "text", delta: "Hello " },
        { index: 1, type: "text", delta: "World" },
      ],
    });
    expect(result.current.streamedText).toBe("Hello World");

    // Disconnect: index 2 was in flight but never delivered before the drop.
    setStream({ error: new Error("dropped") });
    await tick(WATCHDOG_INTERVAL_MS);

    // reconcileIfStale-equivalent REST call reported lastStreamIndex: 1 —
    // the resubscribe must resume from index 2, not re-request 0/1.
    const call = __latestStreamCall();
    expect(call.options.startIndex).toBe(2);

    // The resumed subscription delivers the previously-missed part.
    setStream({
      parts: [
        { index: 0, type: "text", delta: "Hello " },
        { index: 1, type: "text", delta: "World" },
        { index: 2, type: "text", delta: "!" },
      ],
    });
    expect(result.current.streamedText).toBe("Hello World!");
  });
});

describe("useActiveRun — REST-terminal-wins ordering", () => {
  it("a terminal status observed while isReconnecting is true is reflected immediately, not blocked by the stale reconnecting flag", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    // Put the hook into a reconnecting state.
    setStream({ error: new Error("dropped") });
    await tick(WATCHDOG_INTERVAL_MS);
    expect(result.current.isReconnecting).toBe(true);

    // A realtime run-status payload now confirms the run finished — this
    // must win immediately over the stale isReconnecting flag. `finalize()`
    // awaits query invalidation before its state updates land, so this needs
    // a microtask flush — `waitFor`'s real-timer polling never resolves
    // under `vi.useFakeTimers()`, hence the plain async `act` instead.
    setRunStatus({ run: { status: "COMPLETED" } });
    await act(async () => {});
    expect(result.current.isActive).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.activeRun).toBeNull();
  });
});

describe("useActiveRun — terminal-detection race across a chat switch", () => {
  it("a stale finalize() for a run that's no longer current must not clobber a newer run's state or leak its error", async () => {
    let resolveGetRun!: (run: AgentRunDTO) => void;
    const pending = new Promise<AgentRunDTO>((resolve) => {
      resolveGetRun = resolve;
    });
    vi.mocked(runsService.getRun).mockReturnValue(pending);

    const { result, rerender } = renderHook(({ chatId }) => useActiveRun(chatId, null), {
      wrapper,
      initialProps: { chatId: "chat1" },
    });
    act(() => result.current.start(makeRun({ id: "run1", chatId: "chat1" }), makeRealtime()));

    // Realtime confirms run1 finished — this kicks off the one-shot REST
    // reconcile fetch (terminal-detection effect), held pending here to
    // simulate a slow network round trip.
    setRunStatus({ run: { status: "COMPLETED" } });
    await act(async () => {});

    // The user switches chats before that fetch resolves; chat2 loads its
    // own, unrelated active run the same way reload-recovery would. Reset
    // the mocked realtime run-status back to "no report yet" first — the
    // mock's single global cell would otherwise keep reporting run1's stale
    // COMPLETED status against run2 too (the real SDK hook re-keys per
    // runId and wouldn't), which would spuriously finalize run2 itself and
    // mask the actual race under test.
    rerender({ chatId: "chat2" });
    await act(async () => {});
    setRunStatus({ run: undefined });
    act(() => result.current.start(makeRun({ id: "run2", chatId: "chat2" }), makeRealtime()));

    // The stale run1 fetch now resolves — reporting run1 as failed.
    await act(async () => {
      resolveGetRun(makeRun({ id: "run1", status: "failed", errorCode: "boom", errorMessage: "run1 broke" }));
      await pending;
    });

    // run2 must still be the active run, untouched by run1's belated
    // finalize — and run1's error must not have leaked onto it.
    expect(result.current.activeRun?.id).toBe("run2");
    expect(result.current.isActive).toBe(true);
    expect(result.current.lastRunError).toBeNull();
  });
});

describe("useActiveRun — connection-lost slow-poll bound", () => {
  it("polls at CONNECTION_LOST_POLL_MS (not the fast backoff schedule) once connectionLost is set, and stops the instant a terminal state is observed", async () => {
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun());
    const { result } = renderHook(() => useActiveRun("chat1", null), { wrapper });
    act(() => result.current.start(makeRun(), makeRealtime()));

    setStream({ error: new Error("fail-0") });
    await tick(WATCHDOG_INTERVAL_MS);
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
      setStream({ error: new Error(`fail-${i + 1}`) });
      await tick(RECONNECT_BACKOFF_MS[i]);
    }
    expect(result.current.connectionLost).toBe(true);
    const callsAtExhaustion = vi.mocked(runsService.getRun).mock.calls.length;

    // Well short of CONNECTION_LOST_POLL_MS — no poll yet.
    await tick(CONNECTION_LOST_POLL_MS - 1_000);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAtExhaustion);

    // Crossing it fires exactly one slow-poll REST call.
    await tick(1_000);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAtExhaustion + 1);

    // That poll now reports the run finished — polling must stop immediately.
    // Same fake-timer/`waitFor` incompatibility as the REST-terminal-wins
    // test above — `tick()` already flushes the microtasks `finalize()`
    // needs, so no extra wait is needed once it returns.
    vi.mocked(runsService.getRun).mockResolvedValue(makeRun({ status: "completed" }));
    await tick(CONNECTION_LOST_POLL_MS);
    expect(result.current.isActive).toBe(false);
    const callsAfterFinalize = vi.mocked(runsService.getRun).mock.calls.length;

    await tick(CONNECTION_LOST_POLL_MS * 2);
    expect(vi.mocked(runsService.getRun).mock.calls.length).toBe(callsAfterFinalize);
  });
});
