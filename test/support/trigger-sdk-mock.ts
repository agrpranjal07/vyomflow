/**
 * Mock for the raw "@trigger.dev/sdk" package, used only by
 * src/services/runs.ts's `reconcileIfStale` (`triggerRuns.retrieve`) in
 * tests that exercise the reconciler's Trigger.dev-facing branches
 * (RUN_ORPHAN_HARD_TIMEOUT_MS backstop, TRIGGER_RETRIEVE_TIMEOUT_MS race,
 * reconciliation_incomplete). Every other integration test that touches a
 * route importing src/server/dispatch.ts already mocks that module wholesale
 * via ../support/trigger-mock — this file is a separate seam for the one
 * remaining real "@trigger.dev/sdk" import in the reconciler.
 *
 * Usage (the vi.mock call itself must live in the test file for Vitest's
 * hoisting, same pattern as trigger-mock.ts):
 *
 *   vi.mock("@trigger.dev/sdk", () => import("../support/trigger-sdk-mock"));
 *   import { __setRetrieveResult, __resetTriggerSdkMock } from "../support/trigger-sdk-mock";
 */
import { vi } from "vitest";

type RetrieveResult = { status: string } | null;

// Default: never called unless a test overrides it — reconcileIfStale only
// reaches `retrieve` for a stale run with a confirmed triggerRunId, which no
// other integration test's fast-path data sets up.
let retrieveImpl: (triggerRunId: string) => Promise<RetrieveResult> = async () => {
  throw new Error("trigger-sdk-mock: retrieve called without a test-configured __setRetrieveResult");
};

export function __setRetrieveResult(fn: (triggerRunId: string) => Promise<RetrieveResult>) {
  retrieveImpl = fn;
}

// S6 — waitpoint token state, keyed by the mock token id `createToken`
// hands back. `forToken` resolves immediately with whatever
// `completeToken` last recorded for that id (or `{}` if never completed) —
// tests that need to assert on the pre-resolution "suspended" state should
// inspect the DB row/stream part instead of this in-memory map.
let waitpointTokens = new Map<string, { resolved: boolean; output: unknown }>();

export function __resetTriggerSdkMock() {
  retrieveImpl = async () => {
    throw new Error("trigger-sdk-mock: retrieve called without a test-configured __setRetrieveResult");
  };
  waitpointTokens = new Map();
  streamParts = [];
  scopedStreamParts.clear();
  scopedRunShapes.clear();
}

// S8 Phase 4 (public stream route) — a plain async-iterable-over-an-array
// stand-in for the real SDK's AsyncIterableStream/RunSubscription. Finite
// and pre-populated per test scenario (no live cross-call push queue is
// needed: src/app/api/public/v1/runs/[runId]/stream/route.ts calls
// `streams.read`/`runs.subscribeToRun` fresh on every request, so each
// simulated connection just gets its own already-known backlog). Honors
// `signal` so the route's `cancel()`/cleanup abort path unblocks a reader
// that's still mid-iteration, same as the real SDK.
function makeAsyncIterableFromArray<T>(items: readonly T[], signal?: AbortSignal) {
  let cursor = 0;
  async function next(): Promise<IteratorResult<T>> {
    if (signal?.aborted || cursor >= items.length) {
      return { value: undefined as unknown as T, done: true };
    }
    return { value: items[cursor++], done: false };
  }
  return {
    getReader() {
      return { read: next, releaseLock() {}, cancel: async () => undefined };
    },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };
}

type ScopedStreamPart = { index?: number; [key: string]: unknown };
// Keyed by `${triggerRunId}::${key}` — distinct from the flat `streamParts`
// list below (MCP's simpler no-arg `streams.read()` call shape), since the
// public stream route always passes an explicit (runId, key, options).
const scopedStreamParts = new Map<string, ScopedStreamPart[]>();
export function __setScopedStreamParts(triggerRunId: string, key: string, parts: ScopedStreamPart[]) {
  scopedStreamParts.set(`${triggerRunId}::${key}`, parts);
}

type MockRunShape = { isCompleted?: boolean; isFailed?: boolean; isCancelled?: boolean; [key: string]: unknown };
const scopedRunShapes = new Map<string, MockRunShape[]>();
export function __setRunShapes(triggerRunId: string, shapes: MockRunShape[]) {
  scopedRunShapes.set(triggerRunId, shapes);
}

export const runs = {
  retrieve: vi.fn((triggerRunId: string) => retrieveImpl(triggerRunId)),
  cancel: vi.fn(async () => undefined),
  // Public stream route's run-terminal detection (Promise.all'd alongside
  // the parts pump — see that route's comment on why not Promise.race).
  subscribeToRun: vi.fn((triggerRunId: string, options?: { signal?: AbortSignal }) => {
    const shapes = scopedRunShapes.get(triggerRunId) ?? [];
    return makeAsyncIterableFromArray(shapes, options?.signal);
  }),
};

// Unused by reconcileIfStale but imported elsewhere in backend/src (dispatch.ts,
// src/trigger/*.ts) — safe inert stubs so the aliased mock stays a drop-in
// replacement for the whole package if any other real (unmocked) module in
// the graph happens to import from it.
export const tasks = { trigger: vi.fn(), triggerAndPoll: vi.fn() };
export const idempotencyKeys = { create: vi.fn(async (key: string) => key) };
export const auth = { createPublicToken: vi.fn(async () => "mock-public-token") };
export const task = vi.fn((opts: unknown) => opts);
// S7 — src/trigger/sweep.ts's `reliabilitySweep` uses `schedules.task`, not
// `task` (a cron-scheduled task, not a payload-triggered one). Mirrors
// `task`'s own pass-through stub exactly: the mock returns `opts` verbatim,
// so `reliabilitySweep.run()` is directly callable in tests the same way
// src/trigger/turn.ts's `executeAgentTurn` is invoked directly (that file
// additionally exports its run body as a standalone function; sweep.ts does
// not, so tests call `.run()` on the pass-through object itself).
export const schedules = { task: vi.fn((opts: unknown) => opts) };
// S8 Phase 5 (MCP) — src/mcp/wait.ts's bounded long-poll reads
// `streams.read<TurnStreamPart>(triggerRunId, key, options)` directly
// against the raw SDK. Configurable via `__setStreamParts` so MCP tests can
// simulate a run's realtime stream without a real Trigger.dev connection.
let streamParts: unknown[] = [];
export function __setStreamParts(parts: unknown[]) {
  streamParts = parts;
}
export const streams = {
  define: vi.fn((key: string) => key),
  // Two real overloads share this one mock, distinguished by arg shape:
  // MCP's `read()` (no args — flat `streamParts`/`__setStreamParts`) vs the
  // public stream route's `read(triggerRunId, key, { startIndex, signal })`
  // (per-run backlog via `__setScopedStreamParts`, with `startIndex`
  // filtering and `signal` abort — both needed for that route's
  // resume/duration-limit/disconnect behavior to be testable at all).
  read: vi.fn(async function read(...args: unknown[]) {
    if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "string") {
      const [triggerRunId, key, options] = args as [
        string,
        string,
        ({ startIndex?: number; signal?: AbortSignal } | undefined)?,
      ];
      const all = scopedStreamParts.get(`${triggerRunId}::${key}`) ?? [];
      const startIndex = options?.startIndex ?? 0;
      const filtered = all.filter((p) => typeof p.index !== "number" || p.index >= startIndex);
      return makeAsyncIterableFromArray(filtered, options?.signal);
    }
    const parts = streamParts;
    return (async function* () {
      for (const part of parts) yield part;
    })();
  }),
};

// S6 — src/trigger/turn.ts's waitpoint gates (`wait.createToken`/
// `wait.forToken`) and src/services/waitpoints.ts's resume
// (`wait.completeToken`) all import the raw SDK's `wait` export, mocked
// here the same way `runs`/`tasks`/etc. are above. Shapes verified against
// the installed @trigger.dev/sdk 4.5.11's dist/esm/v3/wait.d.ts:
// `createToken` returns `{id, isCached, url}`; `forToken` returns a
// `ManualWaitpointPromise` resolving to `{ok, output}` (or `{ok: false,
// error}` on timeout — not exercised by this stub, which always resolves
// `ok: true`).
export const wait = {
  createToken: vi.fn(async (opts: { idempotencyKey?: string } = {}) => ({
    id: `wpt_test_${opts.idempotencyKey ?? Math.random().toString(36).slice(2)}`,
    isCached: false,
    url: "https://example.test/waitpoint",
  })),
  forToken: vi.fn((id: string) => Promise.resolve({ ok: true, output: waitpointTokens.get(id)?.output ?? {} })),
  completeToken: vi.fn(async (token: { id: string }, output: unknown) => {
    waitpointTokens.set(token.id, { resolved: true, output });
    return { success: true as const };
  }),
};

// src/lib/logger.ts imports `logger` from "@trigger.dev/sdk" unconditionally
// — any test that transitively loads it while this module is mocked needs
// this stub, or the import itself throws.
export const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
