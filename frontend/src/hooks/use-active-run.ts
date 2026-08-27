"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeStream, useRealtimeRun } from "@trigger.dev/react-hooks";
import { useApiClient } from "@/hooks/use-api-client";
import * as runsService from "@/services/runs";
import * as waitpointsService from "@/services/waitpoints";
import { messageKeys } from "@/hooks/use-messages";
import { chatKeys } from "@/hooks/use-chats";
import { creditKeys } from "@/hooks/use-credits";
import { useCreditPaywall } from "@/components/credits/paywall-provider";
import type { AgentRunDTO, RealtimeAccess, TurnStreamPart } from "@/contracts/runs";
import type { ToolInvocationDTO } from "@/contracts/tools";
import type { RespondToWaitpointRequest, WaitpointDTO } from "@/contracts/waitpoints";
import {
  isTerminalRunStatus,
  isTerminalToolStatus,
  isTriggerTerminalStatus,
  computeStartIndex,
  accumulateStreamedText,
  accumulateStreamedTools,
  mergeRestToolState,
  buildStreamedSegments,
  latestWaitpointFromStream,
} from "@/lib/run-status";

// Refresh the realtime token this far ahead of its expiry.
const TOKEN_REFRESH_MARGIN_MS = 60_000;
// Bounded realtime-reconnect backoff (realtime-transport-policy.md).
// @trigger.dev/react-hooks never reconnects on its own — its subscribe
// effect only re-runs when `enabled` changes — so a detected disconnect or
// stall is handled by forcing a fresh subscription (resumed from the
// corrected `lastStreamIndex`), not by falling back to REST polling as the
// steady-state transport.
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
// No stream part or run-status delivery for this long, while still
// enabled and non-terminal, is treated as a stalled connection even with
// no explicit SDK `error` — some SSE gateways/proxies close an idle
// connection cleanly (the subscription's for-await loop just ends) without
// ever emitting one.
const STREAM_STALE_MS = 20_000;
// While at least one tool is genuinely in flight (a non-terminal `type:
// "tool"` stream entry exists), the flat STREAM_STALE_MS above is far
// shorter than normal tool latency (a single generate_image call commonly
// runs 30-90s+ with zero intervening stream parts by design — there is no
// intermediate progress channel) and would otherwise routinely misfire as
// a "stall", forcing a REST reconcile + resubscribe that wasn't needed and
// costing a chance to miss a stream part across the resubscribe. Mirrors
// the backend's own media-tool execution deadline (MEDIA_TOOL_EXEC_DEADLINE_MS,
// backend/src/lib/config.ts) plus headroom, so a tool that's legitimately
// still running never trips this early.
const TOOL_STREAM_STALE_MS = 6 * 60_000;
// Liveness-check cadence while the connection looks healthy — a local
// timestamp comparison, not a request to the server.
const WATCHDOG_INTERVAL_MS = 5_000;
// Once bounded reconnect attempts are exhausted (`connectionLost`), the
// stream is presumed permanently dead — no more resubscribe attempts — but
// a slow, bounded REST reconciliation keeps checking whether the run has
// actually finished server-side, so a permanently-404'd stream still
// resolves silently instead of leaving the UI frozen forever
// (realtime-transport-policy.md's explicitly-permitted "polling as ultimate
// fallback" case: bounded, backed off far below the active-reconnect
// cadence, stops immediately once `finalize()` runs).
const CONNECTION_LOST_POLL_MS = 60_000;
// A token refresh scheduled with less than this much time remaining is
// floored to this delay instead of firing near-immediately (or in a loop,
// for an already-expired token) — a few seconds is enough headroom for the
// refresh call itself to land before the token would actually expire.
const TOKEN_REFRESH_MIN_DELAY_MS = 3_000;
// Realtime stream subscription lifetime, sized with the same headroom as
// the backend's media-tool task maxDuration so a multi-round tool turn's
// stream doesn't time out mid-turn.
const STREAM_TIMEOUT_SECONDS = 300;

/**
 * Owns the realtime lifecycle for a chat's active (non-terminal) run
 * (S2-streaming-turn.md; .claude/rules/realtime-transport-policy.md).
 * Transport priority:
 *   1. `useRealtimeStream` — token deltas (primary, per streams.define key).
 *   2. `useRealtimeRun` — realtime run-status (COMPLETED/FAILED/CANCELED/
 *      ...) — drives terminal-state detection directly, never polled.
 *   3. REST (`GET /runs/:runId`) — durable recovery/reconnect interface:
 *      invoked on mount (reload-recovery) and, bounded, as part of the
 *      reconnect watchdog below when realtime looks unhealthy. Never runs
 *      on any fixed interval while the connection is healthy.
 *
 * Neither SDK subscription reconnects on its own after a drop, so a
 * disconnect (SDK `error`) or stall (no delivery for a while, which also
 * catches a connection a proxy closed cleanly with no error) is handled by
 * forcing a fresh subscription — resumed from a REST-corrected
 * `lastStreamIndex` — on capped exponential backoff, not by degrading to
 * REST polling as the steady-state transport.
 */
export function useActiveRun(chatId: string, seedActiveRunId: string | null | undefined) {
  const fetcher = useApiClient();
  const queryClient = useQueryClient();
  const { open: openPaywall } = useCreditPaywall();

  const [run, setRun] = useState<AgentRunDTO | null>(null);
  const [realtime, setRealtime] = useState<RealtimeAccess | null>(null);
  // Briefly disables both realtime subscriptions so their effects tear down
  // and re-run — the only way to force @trigger.dev/react-hooks to open a
  // fresh SSE connection, since it has no reconnect of its own.
  const [reconnectSuspended, setReconnectSuspended] = useState(false);
  // Surfaced once the bounded reconnect attempts are exhausted and the run
  // is still (as far as we can tell) non-terminal — an explicit,
  // explainable state instead of silently leaving a fake streaming cursor
  // running forever.
  const [connectionLost, setConnectionLost] = useState(false);
  // Locally-owned "is the UI currently in a reconnect attempt" flag — never
  // derived directly from the SDK's own `stream.error`/`runStatus.error`.
  // Both are backed by an SWR cell keyed on a *stable* id
  // (`useId()`/runId/streamKey never change across a resubscribe), so once
  // either fires once it never resets to `undefined` again for the life of
  // this run, even after a later resubscribe succeeds and data resumes
  // flowing. Deriving `hasError`/"(reconnecting…)" straight from that value
  // (the original bug) latched the UI into a permanent reconnecting/
  // connection-lost state after any single transient error. This flag is
  // instead set true only when the watchdog below decides to act, and reset
  // false the moment fresh activity is actually observed.
  const [isReconnecting, setIsReconnecting] = useState(false);
  const reconnectAttempts = useRef(0);
  // Snapshot of the SDK error objects already "accounted for" (acted on or
  // superseded by later healthy activity) — reference identity only. A
  // later genuinely-new error will be a different object (SWR's `mutate`
  // always installs a new reference when `setError(err)` runs), so
  // comparing against this ref distinguishes "a fresh failure just
  // happened" from "the SDK is still holding the same stale error object
  // from before we already recovered."
  const handledErrors = useRef<{ stream: unknown; run: unknown }>({ stream: undefined, run: undefined });
  // Timestamp the watchdog's next scheduled action is allowed to fire at.
  // Read/written across effect (re)runs so an `enabled` toggle (e.g.
  // forceResubscribe's own suspend/resume) restarting the effect doesn't
  // truncate an in-flight backoff wait back to the top of the interval.
  const nextAttemptAtRef = useRef(0);
  // Not `useRef(Date.now())` — calling `Date.now()` during render is an
  // impure render call React's compiler rule rejects. `0` is a safe initial
  // sentinel: the watchdog effect below only ever runs once `run` is set,
  // and every path that sets `run` (`start`, reload-recovery, a successful
  // reconcile) also stamps a fresh `Date.now()` itself, from a callback or
  // effect body rather than render.
  const lastActivityAt = useRef(0);
  // Bounded REST reconciliation overlay (realtime-transport-policy.md §6):
  // populated from `AgentRunDTO.toolInvocations` on every REST fetch this
  // hook already makes (reload-recovery, watchdog reconcile,
  // connection-lost slow-poll) and merged over the stream-derived tool
  // state below — the server-confirmed terminal status always wins over a
  // stream part that may be stale or never arrived. Keyed by
  // toolInvocationId; cleared on `start`/chat-switch so a previous run's
  // entries never leak into a new one. State, not a ref — it's read during
  // render (in the `streamedTools` computation below) and this project's
  // react-hooks/refs rule forbids reading `ref.current` during render.
  const [restToolOverlay, setRestToolOverlay] = useState<Map<string, ToolInvocationDTO>>(new Map());
  // Dedup set for the per-tool-terminal credits invalidation (S7 §5.3) —
  // ensures a 20-delta stream for one tool triggers at most one
  // invalidateQueries call, keyed by toolInvocationId, not by delta count.
  // Reference identity only (a ref, not state) since it never drives a
  // render itself. Cleared on start()/finalize() so a previous run's ids
  // never suppress a same-id invalidation on a later run.
  const invalidatedCreditToolIds = useRef<Set<string>>(new Set());
  // S6 §7.7 — a terminal run's server-owned error, surfaced after `run` is
  // nulled (MessageDTO carries no error fields of its own). Cleared by
  // `start()`/chat-switch; never referenced while `run` is still non-null.
  const [lastRunError, setLastRunError] = useState<{
    assistantMessageId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  } | null>(null);
  // S6 §7.8 — the run's currently pending waitpoint (approval/clarification),
  // reconciled from both REST (`AgentRunDTO.pendingWaitpoint`, reload-
  // recovery) and realtime (`type: "waitpoint"` stream parts, so
  // ApprovalOverlay reacts immediately without waiting on a REST round trip).
  const [pendingWaitpoint, setPendingWaitpoint] = useState<WaitpointDTO | null>(null);
  // Waitpoint ids the human has already responded to this run — see the
  // stream-derived effect below for why this exists.
  const resolvedWaitpointIds = useRef<Set<string>>(new Set());

  const mergeToolInvocations = useCallback((invocations: ToolInvocationDTO[]) => {
    if (invocations.length === 0) return;
    setRestToolOverlay((prev) => {
      const next = new Map(prev);
      for (const inv of invocations) next.set(inv.id, inv);
      return next;
    });
  }, []);

  // S6 §7.7 — retained across the `setRun(null)` below so the message list
  // can render a failed/cancelled run's server-owned error after the
  // streaming bubble unmounts (Message DTO itself carries no error fields;
  // only AgentRunDTO does). Cleared by the next `start()`.
  const finalize = useCallback(
    async (finalRun?: AgentRunDTO) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: messageKeys.list(chatId) }),
        queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) }),
        // S7 §5.3 — the balance the run just settled must be reflected the
        // moment the run terminalizes, driven by this existing realtime-
        // sourced finalize(), never by polling.
        queryClient.invalidateQueries({ queryKey: creditKeys.all }),
      ]);
      if (finalRun && (finalRun.status === "failed" || finalRun.status === "cancelled")) {
        setLastRunError({
          assistantMessageId: finalRun.assistantMessageId,
          errorCode: finalRun.errorCode,
          errorMessage: finalRun.errorMessage,
        });
      }
      setRun(null);
      setRealtime(null);
      setConnectionLost(false);
      setIsReconnecting(false);
      setPendingWaitpoint(null);
      reconnectAttempts.current = 0;
      invalidatedCreditToolIds.current = new Set();
      resolvedWaitpointIds.current = new Set();
    },
    [queryClient, chatId],
  );

  /** Seeds state directly from a just-completed send — no extra REST round trip. */
  const start = useCallback((newRun: AgentRunDTO, newRealtime: RealtimeAccess) => {
    reconnectAttempts.current = 0;
    lastActivityAt.current = Date.now();
    handledErrors.current = { stream: undefined, run: undefined };
    invalidatedCreditToolIds.current = new Set();
    setRestToolOverlay(new Map());
    setConnectionLost(false);
    setIsReconnecting(false);
    setLastRunError(null);
    setPendingWaitpoint(newRun.pendingWaitpoint);
    setRun(newRun);
    setRealtime(newRealtime);
  }, []);

  const forceResubscribe = useCallback(() => {
    lastActivityAt.current = Date.now();
    setReconnectSuspended(true);
    // Flipping back on must happen in a later tick — a synchronous second
    // setState here would batch with the first and `enabled` would never
    // actually pass through `false`, so the SDK's subscribe effect would
    // never see a change and never resubscribe. `requestAnimationFrame` can
    // be throttled to ~0Hz in a backgrounded tab, stalling this indefinitely
    // — `setTimeout` keeps firing regardless of tab visibility.
    setTimeout(() => setReconnectSuspended(false), 0);
  }, []);

  // A chat switch mid-stream must not leak the previous chat's live run
  // into the new chat's view — reset every piece of this hook's local
  // state. Deliberately NOT run on mount: everything is already at its
  // initial value then, so a mount pass would only defer a wipe of state
  // that `start()` legitimately populated immediately after mount.
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current === chatId) return;
    prevChatIdRef.current = chatId;
    // Deferred a tick (react-hooks/set-state-in-effect) — same reasoning as
    // forceResubscribe's setTimeout above: a setState call synchronous
    // within the effect body itself is flagged even when harmless here.
    queueMicrotask(() => {
      setRun(null);
      setRealtime(null);
      setConnectionLost(false);
      setIsReconnecting(false);
      setRestToolOverlay(new Map());
      setLastRunError(null);
      setPendingWaitpoint(null);
    });
    reconnectAttempts.current = 0;
    handledErrors.current = { stream: undefined, run: undefined };
    // finalizedRunId is deliberately left alone — it's only ever compared
    // against a fresh run's id (unique per run), so a stale value from the
    // previous chat can never falsely match and suppress a real finalize().
    lastActivityAt.current = 0;
    nextAttemptAtRef.current = 0;
  }, [chatId]);

  // Reload-recovery: hydrate from REST when the chat reports a
  // non-terminal run we don't already have local state for.
  useEffect(() => {
    if (!seedActiveRunId || run) return;
    let cancelled = false;
    (async () => {
      try {
        const [freshRun, freshToken] = await Promise.all([
          runsService.getRun(fetcher, seedActiveRunId),
          runsService.getRealtimeToken(fetcher, seedActiveRunId),
        ]);
        if (cancelled) return;
        mergeToolInvocations(freshRun.toolInvocations);
        if (!isTerminalRunStatus(freshRun.status)) {
          reconnectAttempts.current = 0;
          lastActivityAt.current = Date.now();
          handledErrors.current = { stream: undefined, run: undefined };
          setRun(freshRun);
          setRealtime(freshToken);
          setPendingWaitpoint(freshRun.pendingWaitpoint);
        }
      } catch {
        // Best-effort hydration — the chat's own message list is still the
        // durable source of truth if this fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedActiveRunId, run, fetcher, mergeToolInvocations]);

  // Token refresh, scheduled ahead of expiry.
  useEffect(() => {
    if (!run || !realtime) return;
    const msUntilRefresh = new Date(realtime.expiresAt).getTime() - Date.now() - TOKEN_REFRESH_MARGIN_MS;
    const timer = setTimeout(
      async () => {
        try {
          const fresh = await runsService.getRealtimeToken(fetcher, run.id);
          setRealtime(fresh);
        } catch {
          // Next scheduled refresh (or a stream error) will retry.
        }
      },
      Math.max(TOKEN_REFRESH_MIN_DELAY_MS, msUntilRefresh),
    );
    return () => clearTimeout(timer);
  }, [run, realtime, fetcher]);

  // Whether this chat has an active run at all — composer/Stop-button
  // facing. Deliberately independent of the SDK subscriptions' own
  // moment-to-moment `enabled` (below), which briefly toggles off and back
  // on to force a resubscribe; the run is still active from the user's
  // point of view during that toggle and while `connectionLost`.
  const isActive = Boolean(run && realtime);
  const enabled = isActive && !reconnectSuspended;

  const stream = useRealtimeStream<TurnStreamPart>(realtime?.runId ?? "", realtime?.streamKey ?? "assistant", {
    accessToken: realtime?.accessToken,
    startIndex: computeStartIndex(run),
    throttleInMs: 50,
    timeoutInSeconds: STREAM_TIMEOUT_SECONDS,
    enabled,
  });

  const runStatus = useRealtimeRun(realtime?.runId, { accessToken: realtime?.accessToken, enabled });

  // "Latest ref" mirrors of the SDK error objects — lets the watchdog
  // effect below read current errors without listing them as dependencies
  // (see that effect's comment for why). Synced from an effect, not during
  // render (react-hooks/refs forbids mutating a ref while rendering).
  const streamErrorRef = useRef(stream.error);
  useEffect(() => {
    streamErrorRef.current = stream.error;
  }, [stream.error]);
  const runStatusErrorRef = useRef(runStatus.error);
  useEffect(() => {
    runStatusErrorRef.current = runStatus.error;
  }, [runStatus.error]);
  // Latest stream parts, for the watchdog's dynamic staleness threshold
  // (F4) — the watchdog effect below only re-runs on `enabled`/`run?.id`
  // changes, so it can't close over `stream.parts` directly without going
  // stale; this ref is kept current independent of that effect's lifecycle.
  const streamPartsRef = useRef(stream.parts);
  useEffect(() => {
    streamPartsRef.current = stream.parts;
  }, [stream.parts]);

  // Realtime-driven completion detection — never polled. Guarded on `run`
  // (not just the status value) so this only ever fires once per active
  // run — `run` is nulled the same render `finalize` runs, which is itself
  // a state update, so the guard can't be "derive during render" and must
  // be this ref-based latch instead.
  const finalizedRunId = useRef<string | null>(null);
  useEffect(() => {
    const status = runStatus.run?.status;
    if (!run || !status || !isTriggerTerminalStatus(status)) return;
    if (finalizedRunId.current === run.id) return;
    finalizedRunId.current = run.id;
    // One bounded REST call to pick up the server-owned errorCode/
    // errorMessage the Trigger.dev run-status payload itself doesn't carry
    // (S6 §7.7) — not a polling loop, a single reconcile at terminal
    // detection, same pattern the watchdog/cancel paths already use.
    // `cancelled` guards against a chat switch (or a new run) landing while
    // this fetch is still in flight: without it, a stale finalize() for a
    // run that's no longer current would null out the *new* run/realtime
    // state and could leak the old run's errorCode/errorMessage into
    // `lastRunError` for whatever chat/run is now active — the watchdog
    // effect above guards its own async REST calls the same way.
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await runsService.getRun(fetcher, run.id);
        if (!cancelled) finalize(fresh);
      } catch {
        if (!cancelled) finalize();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runStatus.run?.status, run, finalize, fetcher]);

  // Any successful delivery on either channel counts as activity, resetting
  // the staleness clock the watchdog below checks. It also proves the
  // connection is currently healthy, so it clears the locally-owned
  // `isReconnecting` flag immediately (not just on the next 5s tick) and
  // marks whatever SDK error objects exist right now as "handled" — a
  // *later* error will be a new object reference and will correctly be
  // treated as fresh by the watchdog.
  useEffect(() => {
    if (stream.parts.length > 0 || runStatus.run) {
      lastActivityAt.current = Date.now();
      handledErrors.current = { stream: stream.error, run: runStatus.error };
      // Deferred a tick (react-hooks/set-state-in-effect) — same reasoning
      // as forceResubscribe's requestAnimationFrame below: a setState call
      // synchronous within the effect body itself is flagged even when
      // harmless here, so it's queued instead.
      queueMicrotask(() => setIsReconnecting(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.parts.length, runStatus.run]);

  // Bounded realtime reconnect (realtime-transport-policy.md): the SDK
  // subscriptions never reconnect on their own, so a detected disconnect
  // (`error` from either channel) or stall (no delivery for
  // `STREAM_STALE_MS`, which also catches a connection a proxy closed
  // cleanly with no error at all) triggers, on capped exponential backoff,
  // one REST reconciliation — correcting `lastStreamIndex`/status and
  // catching a terminal state that happened while disconnected — followed
  // by a forced resubscribe from the corrected position. Ticks on a fixed
  // liveness cadence while healthy (pure local timestamp comparisons, no
  // network call) rather than only reacting to state changes, so a silent
  // stall is still caught.
  //
  // Deliberately depends only on stable values (`enabled`, `run?.id`, the
  // memoized callbacks) — NOT `stream.error`/`runStatus.error`/`run` itself
  // (an object reconciled fresh on every REST call in this same effect).
  // Those used to be dependencies, which restarted this effect (tearing
  // down and rescheduling the timer from scratch) on every reconcile and on
  // every `enabled` toggle from `forceResubscribe`'s own suspend/resume —
  // collapsing an in-flight backoff wait back to the next 5s tick.
  // `nextAttemptAtRef` now carries the scheduled deadline across restarts,
  // and current error values are read from the "latest ref" mirrors above
  // instead of the closure.
  useEffect(() => {
    if (!enabled || !run) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const runId = run.id;

    const tick = () => {
      if (cancelled) return;
      // Compare by reference against the last error we already reacted to
      // (or that a later healthy delivery superseded) — not by mere
      // truthiness. Both SDK hooks cache `error` in an SWR cell keyed on a
      // stable id that never changes across a resubscribe, so the same
      // error object lingers there forever once set even after the
      // connection recovers; treating it as "still an active problem" on
      // every tick was the bug that permanently latched the UI into
      // "(reconnecting…)"/"connection lost" after any single transient
      // failure.
      const hasNewSdkError =
        (streamErrorRef.current && streamErrorRef.current !== handledErrors.current.stream) ||
        (runStatusErrorRef.current && runStatusErrorRef.current !== handledErrors.current.run);
      // A tool genuinely in flight (DISPATCHING/QUEUED/RUNNING, per the
      // last-seen stream state) tolerates a much longer silence before
      // being treated as stalled — see TOOL_STREAM_STALE_MS above.
      const hasInFlightTool = accumulateStreamedTools(streamPartsRef.current).some(
        (tool) => tool.status === "DISPATCHING" || tool.status === "QUEUED" || tool.status === "RUNNING",
      );
      const staleThreshold = hasInFlightTool ? TOOL_STREAM_STALE_MS : STREAM_STALE_MS;
      const stalled = Date.now() - lastActivityAt.current >= staleThreshold;
      if (!hasNewSdkError && !stalled) {
        reconnectAttempts.current = 0;
        setIsReconnecting(false);
        nextAttemptAtRef.current = Date.now() + WATCHDOG_INTERVAL_MS;
        timer = setTimeout(tick, WATCHDOG_INTERVAL_MS);
        return;
      }
      setIsReconnecting(true);
      if (reconnectAttempts.current >= RECONNECT_BACKOFF_MS.length) {
        // Bounded reconnect exhausted — stop resubscribing, but don't
        // freeze: keep checking, on a slow bounded interval, whether the
        // run actually finished server-side while the stream was
        // unreachable (permitted "polling as ultimate fallback",
        // realtime-transport-policy.md). Stops the instant `finalize()`
        // runs; never resumes active reconnect on its own since the stream
        // is presumed permanently dead at this point.
        setConnectionLost(true);
        void (async () => {
          try {
            const fresh = await runsService.getRun(fetcher, runId);
            if (cancelled) return;
            mergeToolInvocations(fresh.toolInvocations);
            if (isTerminalRunStatus(fresh.status)) {
              finalize(fresh);
              return;
            }
          } catch {
            // Still unreachable — the next slow-interval tick retries.
          }
          if (cancelled) return;
          nextAttemptAtRef.current = Date.now() + CONNECTION_LOST_POLL_MS;
          timer = setTimeout(tick, CONNECTION_LOST_POLL_MS);
        })();
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[reconnectAttempts.current];
      reconnectAttempts.current += 1;
      void (async () => {
        try {
          const fresh = await runsService.getRun(fetcher, runId);
          if (cancelled) return;
          mergeToolInvocations(fresh.toolInvocations);
          if (isTerminalRunStatus(fresh.status)) {
            finalize(fresh);
            return;
          }
          setConnectionLost(false);
          setRun(fresh);
          setPendingWaitpoint(fresh.pendingWaitpoint);
        } catch {
          // REST itself failed — still worth forcing a resubscribe below;
          // the next tick reassesses and retries either path.
        }
        if (cancelled) return;
        handledErrors.current = { stream: streamErrorRef.current, run: runStatusErrorRef.current };
        forceResubscribe();
        nextAttemptAtRef.current = Date.now() + delay;
        timer = setTimeout(tick, delay);
      })();
    };

    // A restart of this effect (e.g. from `forceResubscribe`'s own
    // `enabled` toggle) must not truncate an already-scheduled wait. `0` is
    // the sentinel for "never scheduled" (see `nextAttemptAtRef`'s init
    // comment above) — a *legitimately due-now* deadline also computes to
    // `0` via `Math.max`, so `|| WATCHDOG_INTERVAL_MS` would wrongly treat
    // "fire immediately" as "nothing scheduled, use the default interval,"
    // producing a spurious extra tick on the short interval that observes
    // the same already-handled error and wrongly resets the backoff count.
    const initialDelay =
      nextAttemptAtRef.current === 0
        ? WATCHDOG_INTERVAL_MS
        : Math.max(0, nextAttemptAtRef.current - Date.now());
    timer = setTimeout(tick, initialDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `run` (the object) is deliberately omitted — only `run?.id` should
    // restart this effect; the full object is a fresh reference on every
    // reconcile inside this same effect, which previously collapsed
    // in-flight backoff waits (see the effect's own comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run?.id, fetcher, finalize, forceResubscribe, mergeToolInvocations]);

  // S6 §7.8/Task D — a realtime "waitpoint" stream part updates local state
  // the instant it arrives, so ApprovalOverlay doesn't wait on a REST round
  // trip. A part carrying a non-PENDING waitpoint (already resolved) clears
  // it, matching `respond()`'s own optimistic-clear rule.
  //
  // Bug fix: the backend writes exactly one "waitpoint" stream part per
  // waitpoint, at creation time — its embedded WaitpointDTO snapshot is
  // always status "PENDING" and is never re-emitted after resolution. This
  // effect re-runs on every `stream.parts` change (including the approved
  // tool's own subsequent DISPATCHING/RUNNING deltas, since `stream.parts`
  // gets a fresh array reference on every new part), so without the
  // `resolvedWaitpointIds` guard below it would keep re-deriving that same
  // stale PENDING snapshot and reopen ApprovalOverlay after the user had
  // already approved/declined it (observed live: the approval banner stayed
  // interactive underneath the tool's own running spinner). `respond()`
  // records the id there the moment it optimistically clears local state.
  useEffect(() => {
    const wp = latestWaitpointFromStream(stream.parts);
    if (wp && resolvedWaitpointIds.current.has(wp.id)) return;
    // Deferred a tick (react-hooks/set-state-in-effect) — same reasoning as
    // forceResubscribe's setTimeout above: a setState call synchronous
    // within the effect body itself is flagged even when harmless here.
    if (wp) queueMicrotask(() => setPendingWaitpoint(wp.status === "PENDING" ? wp : null));
  }, [stream.parts]);

  const streamedText = accumulateStreamedText(stream.parts);
  // Merged with the REST-reconciliation overlay (F3): a server-confirmed
  // terminal status always wins over a stream-derived entry that may be
  // stale or was never delivered.
  const streamedTools = mergeRestToolState(accumulateStreamedTools(stream.parts), restToolOverlay);
  // True chronological interleave of text/tool arrival, for StreamingMessage
  // to render in real order instead of "all text, then all tools" (S-fidelity §9).
  const streamedSegments = buildStreamedSegments(stream.parts, restToolOverlay);

  // S7 §5.3 — invalidate the credits query once per toolInvocationId as it
  // reaches a terminal status, not once per stream delta (a 20-delta stream
  // for one tool must trigger at most one refetch). Dedup via the ref set
  // above; the effect itself may re-run on every delta (streamedTools is a
  // fresh array each render) but only fires invalidateQueries for ids not
  // already recorded.
  useEffect(() => {
    for (const tool of streamedTools) {
      if (isTerminalToolStatus(tool.status) && !invalidatedCreditToolIds.current.has(tool.toolInvocationId)) {
        invalidatedCreditToolIds.current.add(tool.toolInvocationId);
        queryClient.invalidateQueries({ queryKey: creditKeys.all });
        // A mid-turn reservation failure surfaces here, not as a thrown
        // ApiError — the run itself keeps going (turn.ts:690-717). The tool
        // card still renders its own FAILED/errorMessage state; this only
        // adds the blocking paywall on top, deduped per run by the provider.
        if (tool.status === "FAILED" && tool.errorCode === "insufficient_credits") {
          openPaywall("tool");
        }
      }
    }
  }, [streamedTools, queryClient, openPaywall]);

  const cancel = useCallback(async () => {
    if (!run) return;
    const updated = await runsService.cancelRun(fetcher, run.id);
    if (isTerminalRunStatus(updated.status)) {
      finalize(updated);
    } else {
      setRun(updated);
      setPendingWaitpoint(updated.pendingWaitpoint);
    }
  }, [run, fetcher, finalize]);

  // S6 §7.8 — POSTs the human's response to a pending waitpoint (approval or
  // clarification) and optimistically clears it locally so ApprovalOverlay
  // unmounts immediately; the run's own transition back to "running" is
  // picked up via realtime/REST reconcile like any other status change.
  const respond = useCallback(
    async (waitpointId: string, body: RespondToWaitpointRequest) => {
      const updated = await waitpointsService.respondToWaitpoint(fetcher, waitpointId, body);
      if (updated.status !== "PENDING") {
        resolvedWaitpointIds.current.add(waitpointId);
        setPendingWaitpoint(null);
      }
      return updated;
    },
    [fetcher],
  );

  // Derived per S7-agent-runtime.md §A.2 / S6 plan §7.2 — "cancelling" has no
  // enum member of its own; it's `running` + a stamped `cancelRequestedAt`.
  const isStopping = run?.status === "running" && run?.cancelRequestedAt != null;

  return {
    activeRun: run,
    isActive,
    isStopping,
    streamedText,
    streamedTools,
    streamedSegments,
    isReconnecting,
    connectionLost,
    lastRunError,
    pendingWaitpoint,
    start,
    cancel,
    respond,
  };
}
