/**
 * Pure helpers extracted from use-active-run.ts so the resume-math and
 * status-classification logic is unit-testable without rendering React
 * hooks or mocking @trigger.dev/react-hooks (whose custom source-condition
 * export resolution defeats Vitest's module mocking for a full-hook test).
 */
import type { TurnStreamPart, ToolStreamPart, AgentRunStatus } from "@/contracts/runs";
import type { ToolInvocationDTO, ToolInvocationStatus } from "@/contracts/tools";
import type { WaitpointDTO } from "@/contracts/waitpoints";

/** A live tool-stream entry, possibly upgraded with REST-reconciled `durationMs` (mergeRestToolState below) — the wire `type:"tool"` stream part itself doesn't carry duration. */
export type LiveToolState = ToolStreamPart & { durationMs?: number | null };

const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolInvocationStatus> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Exported for use-active-run.ts's deduped per-tool-terminal credits invalidation (S7 §5.3) — the same terminal vocabulary this module already uses internally. */
export function isTerminalToolStatus(status: ToolInvocationStatus): boolean {
  return TERMINAL_TOOL_STATUSES.has(status);
}

/** Our own AgentRunStatus values that are terminal (never resumed/streamed into again). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set(["completed", "failed", "cancelled"]);

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Trigger.dev's own run-status vocabulary (distinct from our AgentRunStatus
 * enum) — used only to detect "this run is done" so the UI can trigger one
 * REST reconciliation, never to drive UI state directly.
 */
export const TRIGGER_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

export function isTriggerTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TRIGGER_TERMINAL_STATUSES.has(status);
}

/**
 * The `useRealtimeStream` `startIndex` for a given run — inclusive,
 * 0-based (verified against the installed @trigger.dev/react-hooks
 * source). `-1` (no part persisted yet, the AgentRun column's own default)
 * yields `0`, the first part; any other value resumes exactly one past the
 * last durably-persisted chunk, never re-receiving it and never skipping
 * one.
 */
export function computeStartIndex(run: { lastStreamIndex: number } | null): number {
  return run ? run.lastStreamIndex + 1 : 0;
}

/**
 * Concatenates stream parts into the full accumulated text so far, deduped
 * and ordered by each part's own `index` rather than array/arrival order.
 * `@trigger.dev/react-hooks`' `useRealtimeStream` shares one SWR-cached
 * parts array per (runId, streamKey) across resubscribes and simply
 * concatenates whatever a new subscription delivers onto it
 * (`[...existingParts, ...newParts]`, see the installed SDK's
 * `processRealtimeStream`) — it does not dedupe. Our own reconnect
 * (use-active-run.ts's watchdog) can legitimately resume from a REST-
 * corrected `lastStreamIndex` that lags behind parts already delivered
 * over the live connection before the disconnect, so the redelivered range
 * can overlap what's already cached. Deduping by index here (last write
 * per index wins) is what actually prevents that overlap from rendering as
 * duplicated text, and sorting by index protects against any out-of-order
 * delivery race between an old subscription's tail and a new one's start.
 */
export function accumulateStreamedText(parts: TurnStreamPart[]): string {
  const byIndex = new Map<number, string>();
  for (const part of parts) {
    // Reasoning-channel parts reuse the text part shape but are NOT visible
    // answer prose — audit finding H1: without this guard, a reasoning-
    // capable model's chain-of-thought streamed as `channel: "reasoning"`
    // spliced directly into the answer the user is reading, then vanished
    // when the run settled and re-derived from the persisted `reasoning`
    // block instead. See buildStreamedSegments below for where reasoning
    // deltas actually render live (a collapsible step, matching settle).
    if (part.type !== "text" || (part.channel ?? "text") !== "text") continue;
    byIndex.set(part.index, part.delta);
  }
  return Array.from(byIndex.keys())
    .sort((a, b) => a - b)
    .map((index) => byIndex.get(index))
    .join("");
}

/**
 * Live tool state by `toolInvocationId`, folded from `type: "tool"` stream
 * parts (D1) in index order — last write per invocation wins, mirroring
 * `accumulateStreamedText`'s own last-write-per-index dedup so a redelivered
 * range from a reconnect never regresses a tool's status.
 */
export function accumulateStreamedTools(parts: TurnStreamPart[]): ToolStreamPart[] {
  const byInvocation = new Map<string, ToolStreamPart>();
  const order: string[] = [];
  const sorted = parts.filter((p): p is ToolStreamPart => p.type === "tool").sort((a, b) => a.index - b.index);
  for (const part of sorted) {
    if (!byInvocation.has(part.toolInvocationId)) order.push(part.toolInvocationId);
    byInvocation.set(part.toolInvocationId, part);
  }
  return order.map((id) => byInvocation.get(id)!);
}

/**
 * Bounded REST reconciliation for tool state (realtime-transport-policy.md
 * §6: client-owned/stream-derived state must never override a
 * server-confirmed terminal status). `restOverlay` is populated from
 * `AgentRunDTO.toolInvocations` — already fetched on every watchdog
 * reconnect/reload-recovery call, just not previously read for rendering.
 *
 * For each `toolInvocationId` the REST overlay reports terminal
 * (COMPLETED/FAILED/CANCELLED), the REST version wins — it reliably carries
 * `durationMs`/`creditUsed`/`resultUrls`, unlike a stream part that may be
 * stale (never delivered, or lost across a forced resubscribe). Any REST-
 * known invocation the stream accumulator never saw at all is appended
 * (best-effort ordering — these are rare edge cases, not the common path).
 * A REST entry that isn't terminal yet never overrides a stream entry: the
 * stream is still the fresher, primary source while a tool is in flight.
 */
/** A REST-confirmed terminal status always wins over a stream-derived entry for the same invocation (realtime-transport-policy.md §6); otherwise the stream entry (fresher while in flight) passes through unchanged. Shared by `mergeRestToolState` and `buildStreamedSegments` so both apply the exact same override rule. */
function resolveToolWithRestOverlay(
  tool: ToolStreamPart,
  restOverlay: ReadonlyMap<string, ToolInvocationDTO>,
): LiveToolState {
  const rest = restOverlay.get(tool.toolInvocationId);
  if (rest && TERMINAL_TOOL_STATUSES.has(rest.status)) {
    return {
      index: tool.index,
      type: "tool",
      toolInvocationId: tool.toolInvocationId,
      name: rest.name,
      status: rest.status,
      durationMs: rest.durationMs,
      creditUsed: rest.creditUsed ?? undefined,
      resultUrls: rest.resultUrls ?? undefined,
      errorMessage: rest.errorMessage ?? undefined,
    };
  }
  return tool;
}

function restOnlyToolState(id: string, rest: ToolInvocationDTO, index: number): LiveToolState {
  return {
    index,
    type: "tool",
    toolInvocationId: id,
    name: rest.name,
    status: rest.status,
    durationMs: rest.durationMs,
    creditUsed: rest.creditUsed ?? undefined,
    resultUrls: rest.resultUrls ?? undefined,
    errorMessage: rest.errorMessage ?? undefined,
  };
}

export function mergeRestToolState(
  streamed: ToolStreamPart[],
  restOverlay: ReadonlyMap<string, ToolInvocationDTO>,
): LiveToolState[] {
  const seen = new Set(streamed.map((t) => t.toolInvocationId));
  const merged: LiveToolState[] = streamed.map((tool) => resolveToolWithRestOverlay(tool, restOverlay));
  for (const [id, rest] of restOverlay) {
    if (seen.has(id)) continue;
    merged.push(restOnlyToolState(id, rest, Number.MAX_SAFE_INTEGER));
  }
  return merged;
}

export type StreamedSegment =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: LiveToolState };

/**
 * True chronological interleave of a live turn's text, reasoning, and tool
 * calls, using the shared index space these stream parts are documented to
 * share (contracts/runs.ts TurnStreamPartSchema). Fixes: the previous
 * rendering (StreamingMessage) showed all streamed text, then all tool
 * cards, regardless of real arrival order — a tool called mid-prose rendered
 * after the prose that followed it, then "snapped" into the correct order
 * once the turn settled and MessageContent re-derived it from persisted
 * blocks. A tool is positioned at its FIRST-seen index (its DISPATCHING
 * part), not its most recent status update's index, so its card doesn't
 * visually jump position as it transitions to COMPLETED.
 *
 * Reasoning-channel text parts (`channel: "reasoning"`) get their own
 * segment type rather than merging into the plain `text` run — audit
 * finding H1: reasoning reuses the text part shape on the wire, but is not
 * visible answer prose; merging it in would splice a model's chain-of-
 * thought directly into the streamed answer, then make it vanish when the
 * run settles and re-derives from the persisted `reasoning` block instead.
 */
export function buildStreamedSegments(
  parts: TurnStreamPart[],
  restOverlay: ReadonlyMap<string, ToolInvocationDTO> = new Map(),
): StreamedSegment[] {
  const textByIndex = new Map<number, string>();
  const reasoningByIndex = new Map<number, string>();
  const toolFirstIndex = new Map<string, number>();
  const toolLatest = new Map<string, ToolStreamPart>();

  for (const part of [...parts].sort((a, b) => a.index - b.index)) {
    if (part.type === "text") {
      if ((part.channel ?? "text") === "reasoning") reasoningByIndex.set(part.index, part.delta);
      else textByIndex.set(part.index, part.delta);
      continue;
    }
    // S6: a "waitpoint" part doesn't interleave into text/tool prose — it
    // drives ApprovalOverlay via `latestWaitpointFromStream` below instead.
    if (part.type === "waitpoint") continue;
    if (!toolFirstIndex.has(part.toolInvocationId)) toolFirstIndex.set(part.toolInvocationId, part.index);
    toolLatest.set(part.toolInvocationId, part);
  }

  type OrderedEntry =
    | { index: number; type: "text"; text: string }
    | { index: number; type: "reasoning"; text: string }
    | { index: number; type: "tool"; tool: LiveToolState };
  const entries: OrderedEntry[] = [];
  for (const [index, text] of textByIndex) entries.push({ index, type: "text", text });
  for (const [index, text] of reasoningByIndex) entries.push({ index, type: "reasoning", text });
  for (const [id, firstIndex] of toolFirstIndex) {
    entries.push({ index: firstIndex, type: "tool", tool: resolveToolWithRestOverlay(toolLatest.get(id)!, restOverlay) });
  }
  for (const [id, rest] of restOverlay) {
    if (toolFirstIndex.has(id)) continue;
    entries.push({ index: Number.MAX_SAFE_INTEGER, type: "tool", tool: restOnlyToolState(id, rest, Number.MAX_SAFE_INTEGER) });
  }
  entries.sort((a, b) => a.index - b.index);

  // Only consecutive same-type entries merge into one segment — a text run
  // adjacent to a reasoning run stays two segments, never blended.
  const segments: StreamedSegment[] = [];
  let buffer: string[] = [];
  let bufferType: "text" | "reasoning" | null = null;
  const flushBuffer = () => {
    if (buffer.length === 0 || bufferType === null) return;
    segments.push({ type: bufferType, text: buffer.join("") } as StreamedSegment);
    buffer = [];
    bufferType = null;
  };
  for (const entry of entries) {
    if (entry.type === "tool") {
      flushBuffer();
      segments.push({ type: "tool", tool: entry.tool });
      continue;
    }
    if (bufferType !== null && bufferType !== entry.type) flushBuffer();
    bufferType = entry.type;
    buffer.push(entry.text);
  }
  flushBuffer();
  return segments;
}

/**
 * S6 — the most-recently-indexed `type: "waitpoint"` stream part, so
 * ApprovalOverlay reacts the moment the backend creates/resolves a
 * waitpoint over realtime, without waiting on a REST reconcile
 * (S6-reliability-implementation-plan.md §7.8). `null` when no waitpoint
 * part has arrived this run.
 */
export function latestWaitpointFromStream(parts: TurnStreamPart[]): WaitpointDTO | null {
  let latest: { index: number; waitpoint: WaitpointDTO } | null = null;
  for (const part of parts) {
    if (part.type !== "waitpoint") continue;
    if (!latest || part.index > latest.index) latest = { index: part.index, waitpoint: part.waitpoint };
  }
  return latest?.waitpoint ?? null;
}
