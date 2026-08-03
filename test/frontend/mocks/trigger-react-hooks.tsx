import { useSyncExternalStore } from "react";

/**
 * Global stand-in for "@trigger.dev/react-hooks" in the frontend RTL suite
 * (see the "@trigger.dev/react-hooks" alias in vitest.frontend.config.mts).
 * Two independent reasons a test file's own `vi.mock("@trigger.dev/react-hooks", ...)`
 * can't be used instead, same pattern as the next/link and @clerk/nextjs
 * aliases in that config:
 *   1. the package is only installed in frontend/node_modules (not this
 *      workspace's) — resolving it from a test file finds a different
 *      module identity than the one use-active-run.ts actually imports, so
 *      a `vi.mock` declared there never intercepts it.
 *   2. run-status.test.ts's own file header separately documents that this
 *      package's custom source-condition export resolution "defeats
 *      Vitest's module mocking" even when the resolution mismatch above
 *      isn't in play.
 * A controllable fake keyed on a single module-level store (reset between
 * tests via __mockReset) — every call to either hook is also recorded so a
 * test can assert on the exact `startIndex`/`enabled`/`accessToken` args
 * use-active-run.ts passed in.
 */

type StreamState = { parts: unknown[]; error: unknown };
type RunState = { run: { status: string } | undefined; error: unknown };

let streamState: StreamState = { parts: [], error: undefined };
let runState: RunState = { run: undefined, error: undefined };
let streamCalls: Array<{ runId: string; streamKey: string; options: Record<string, unknown> }> = [];
let runCalls: Array<{ runId: string | undefined; options: Record<string, unknown> }> = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Resets all mock state — call from beforeEach/afterEach in every test file using this mock. */
export function __mockReset() {
  streamState = { parts: [], error: undefined };
  runState = { run: undefined, error: undefined };
  streamCalls = [];
  runCalls = [];
  listeners.clear();
}

/** Merges into the current stream state (parts/error) and notifies subscribers — simulates a new SDK delivery. */
export function __setStreamState(next: Partial<StreamState>) {
  streamState = { ...streamState, ...next };
  notify();
}

/** Merges into the current run-status state (run/error) and notifies subscribers. */
export function __setRunState(next: Partial<RunState>) {
  runState = { ...runState, ...next };
  notify();
}

export function __getStreamCalls() {
  return streamCalls;
}

export function __getRunCalls() {
  return runCalls;
}

export function __latestStreamCall() {
  return streamCalls[streamCalls.length - 1];
}

export function useRealtimeStream<T = unknown>(
  runId: string,
  streamKey: string,
  options: Record<string, unknown>,
): { parts: T[]; error: unknown } {
  streamCalls.push({ runId, streamKey, options });
  return useSyncExternalStore(subscribe, () => streamState) as { parts: T[]; error: unknown };
}

export function useRealtimeRun(
  runId: string | undefined,
  options: Record<string, unknown>,
): { run: { status: string } | undefined; error: unknown } {
  runCalls.push({ runId, options });
  return useSyncExternalStore(subscribe, () => runState);
}
