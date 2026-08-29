import { describe, it, expect } from "vitest";
import {
  computeStartIndex,
  accumulateStreamedText,
  accumulateStreamedTools,
  isTerminalRunStatus,
  isTriggerTerminalStatus,
  mergeRestToolState,
  buildStreamedSegments,
  latestWaitpointFromStream,
} from "@/lib/run-status";
import type { TurnStreamPart, ToolStreamPart } from "@/contracts/runs";
import type { ToolInvocationDTO } from "@/contracts/tools";
import type { WaitpointDTO } from "@/contracts/waitpoints";

function toolInvocation(overrides: Partial<ToolInvocationDTO> = {}): ToolInvocationDTO {
  return {
    id: "t1",
    agentRunId: "r1",
    turnIndex: 0,
    callIndex: 0,
    toolCallId: "call1",
    name: "generate_image",
    nodeType: "tool",
    subModelId: null,
    input: {},
    status: "COMPLETED",
    creditEstimate: null,
    creditUsed: 0.14,
    resultUrls: ["https://x/out.png"],
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    durationMs: 4200,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeStartIndex — reload-recovery resume math", () => {
  it("resumes at lastStreamIndex + 1, inclusive/0-based per the trigger.dev react-hooks contract", () => {
    expect(computeStartIndex({ lastStreamIndex: 5 })).toBe(6);
  });

  it("resumes at 0 when lastStreamIndex is -1 (no part persisted yet — the AgentRun column default)", () => {
    expect(computeStartIndex({ lastStreamIndex: -1 })).toBe(0);
  });

  it("defaults to 0 when there is no run at all", () => {
    expect(computeStartIndex(null)).toBe(0);
  });
});

describe("accumulateStreamedText", () => {
  it("concatenates ordered text parts' deltas", () => {
    expect(
      accumulateStreamedText([
        { index: 0, type: "text", delta: "hello" },
        { index: 1, type: "text", delta: " there" },
      ]),
    ).toBe("hello there");
  });

  it("returns an empty string for no parts", () => {
    expect(accumulateStreamedText([])).toBe("");
  });

  it("ignores tool parts sharing the same index space (D1)", () => {
    expect(
      accumulateStreamedText([
        { index: 0, type: "text", delta: "hello" },
        { index: 1, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "RUNNING" },
        { index: 2, type: "text", delta: " there" },
      ]),
    ).toBe("hello there");
  });
});

describe("accumulateStreamedTools", () => {
  it("folds tool parts by toolInvocationId, last write wins, in first-seen order", () => {
    const result = accumulateStreamedTools([
      { index: 0, type: "text", delta: "hi" },
      { index: 1, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "DISPATCHING" },
      { index: 2, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 },
    ]);
    expect(result).toEqual([
      { index: 2, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED", creditUsed: 0.1 },
    ]);
  });

  it("returns an empty array for no tool parts", () => {
    expect(accumulateStreamedTools([{ index: 0, type: "text", delta: "hi" }])).toEqual([]);
  });
});

describe("isTerminalRunStatus — our own AgentRunStatus vocabulary", () => {
  it("treats completed/failed/cancelled as terminal", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("treats queued/running/waiting as non-terminal", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("waiting")).toBe(false);
  });
});

describe("isTriggerTerminalStatus — Trigger.dev's own run-status vocabulary", () => {
  it("treats CRASHED/SYSTEM_FAILURE/TIMED_OUT/EXPIRED/CANCELED/COMPLETED/FAILED as terminal", () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]) {
      expect(isTriggerTerminalStatus(status)).toBe(true);
    }
  });

  it("treats EXECUTING/QUEUED/WAITING/DELAYED as non-terminal", () => {
    for (const status of ["EXECUTING", "QUEUED", "WAITING", "DELAYED", "PENDING_VERSION", "DEQUEUED"]) {
      expect(isTriggerTerminalStatus(status)).toBe(false);
    }
  });

  it("treats an undefined status as non-terminal", () => {
    expect(isTriggerTerminalStatus(undefined)).toBe(false);
  });
});

describe("mergeRestToolState — bounded REST reconciliation overlay (F3, realtime-transport-policy.md §6)", () => {
  it("upgrades a stream-stale entry to the REST-confirmed terminal status", () => {
    const streamed = [{ index: 0, type: "tool" as const, toolInvocationId: "t1", name: "generate_image", status: "RUNNING" as const }];
    const overlay = new Map([["t1", toolInvocation({ status: "COMPLETED", durationMs: 5000 })]]);
    const result = mergeRestToolState(streamed, overlay);
    expect(result).toEqual([
      {
        index: 0,
        type: "tool",
        toolInvocationId: "t1",
        name: "generate_image",
        status: "COMPLETED",
        durationMs: 5000,
        creditUsed: 0.14,
        resultUrls: ["https://x/out.png"],
        errorMessage: undefined,
      },
    ]);
  });

  it("does not override a stream entry when the REST overlay isn't terminal yet", () => {
    const streamed = [{ index: 0, type: "tool" as const, toolInvocationId: "t1", name: "generate_image", status: "RUNNING" as const }];
    const overlay = new Map([["t1", toolInvocation({ status: "RUNNING" })]]);
    expect(mergeRestToolState(streamed, overlay)).toEqual(streamed);
  });

  it("appends a REST-known invocation the stream accumulator never saw at all", () => {
    const overlay = new Map([["t1", toolInvocation()]]);
    const result = mergeRestToolState([], overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ toolInvocationId: "t1", status: "COMPLETED" });
  });

  it("passes through unchanged when the overlay is empty", () => {
    const streamed = [{ index: 0, type: "tool" as const, toolInvocationId: "t1", name: "generate_image", status: "RUNNING" as const }];
    expect(mergeRestToolState(streamed, new Map())).toEqual(streamed);
  });
});

describe("buildStreamedSegments — true chronological interleave of text/tool arrival (assignment §5 'without losing ordering', live path)", () => {
  it("interleaves a tool call in the middle of two text runs, in real arrival order", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", delta: "Before the tool. " },
      { index: 1, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "DISPATCHING" },
      { index: 2, type: "text", delta: "After the tool." },
    ];
    const segments = buildStreamedSegments(parts);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "Before the tool. " });
    expect(segments[1]).toMatchObject({ type: "tool", tool: { toolInvocationId: "t1" } });
    expect(segments[2]).toEqual({ type: "text", text: "After the tool." });
  });

  it("merges consecutive text deltas into one segment rather than one-per-delta", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", delta: "Hello " },
      { index: 1, type: "text", delta: "world" },
    ];
    expect(buildStreamedSegments(parts)).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("keeps a tool positioned at its first-seen index as it transitions status, instead of jumping to its latest update's position", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "DISPATCHING" },
      { index: 1, type: "text", delta: "Cropping now." },
      { index: 2, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "COMPLETED" },
    ];
    const segments = buildStreamedSegments(parts);
    // The tool's card stays BEFORE the text (its first-seen index), even
    // though its most recent update (COMPLETED) arrived after the text.
    expect(segments[0]).toMatchObject({ type: "tool", tool: { toolInvocationId: "t1", status: "COMPLETED" } });
    expect(segments[1]).toEqual({ type: "text", text: "Cropping now." });
  });

  it("applies the REST-terminal overlay to the resolved tool the same way mergeRestToolState does", () => {
    const parts: TurnStreamPart[] = [{ index: 0, type: "tool", toolInvocationId: "t1", name: "crop_image", status: "RUNNING" }];
    const overlay = new Map([["t1", toolInvocation({ status: "COMPLETED", durationMs: 900 })]]);
    const segments = buildStreamedSegments(parts, overlay);
    expect(segments[0]).toMatchObject({ type: "tool", tool: { status: "COMPLETED", durationMs: 900 } });
  });

  it("routes a reasoning-channel text part to its own 'reasoning' segment instead of merging it into the visible answer prose (audit finding H1)", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", channel: "reasoning", delta: "I should crop it first." },
      { index: 1, type: "text", channel: "text", delta: "Here is the answer." },
    ];
    const segments = buildStreamedSegments(parts);
    expect(segments).toEqual([
      { type: "reasoning", text: "I should crop it first." },
      { type: "text", text: "Here is the answer." },
    ]);
  });

  it("does not blend adjacent reasoning and text deltas into one segment even though both are type:text on the wire", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", channel: "reasoning", delta: "Thinking… " },
      { index: 1, type: "text", channel: "reasoning", delta: "still thinking." },
      { index: 2, type: "text", channel: "text", delta: "Answer." },
    ];
    const segments = buildStreamedSegments(parts);
    expect(segments).toEqual([
      { type: "reasoning", text: "Thinking… still thinking." },
      { type: "text", text: "Answer." },
    ]);
  });
});

describe("accumulateStreamedText — excludes reasoning-channel deltas (audit finding H1)", () => {
  it("never includes a reasoning-channel part in the visible answer text", () => {
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", channel: "reasoning", delta: "Secret reasoning. " },
      { index: 1, type: "text", channel: "text", delta: "Visible answer." },
    ];
    expect(accumulateStreamedText(parts)).toBe("Visible answer.");
  });

  it("treats a part with no channel field as ordinary visible text (backward compatibility with the pre-reasoning wire shape)", () => {
    const parts: TurnStreamPart[] = [{ index: 0, type: "text", delta: "Plain text." }];
    expect(accumulateStreamedText(parts)).toBe("Plain text.");
  });
});

// S7 §D / T26 — scalability: a reconnect can redeliver an overlapping range
// of `useRealtimeStream`'s shared parts array (see accumulateStreamedText's
// own doc comment), and at high volume that redelivery can arrive
// out-of-order relative to first delivery. Both accumulators must still
// converge on exactly one entry per index/toolInvocationId — no duplicated
// text, no duplicated/stale tool card — regardless of delivery order.
describe("accumulateStreamedText / accumulateStreamedTools — dedupe under high-volume, out-of-order redelivery (S7 T26)", () => {
  it("accumulateStreamedText: 500 unique indices delivered out of order, plus a fully overlapping shuffled re-delivery, still yields one ordered pass with no duplication", () => {
    const N = 500;
    const original: TurnStreamPart[] = Array.from({ length: N }, (_, i) => ({
      index: i,
      type: "text" as const,
      delta: `${i}|`,
    }));
    // Shuffle a copy to simulate out-of-order arrival, then redeliver the
    // whole range again (also shuffled) to simulate a reconnect overlap.
    const shuffle = (arr: TurnStreamPart[]) => [...arr].sort(() => Math.random() - 0.5);
    const delivered = [...shuffle(original), ...shuffle(original)];

    const result = accumulateStreamedText(delivered);
    const expected = Array.from({ length: N }, (_, i) => `${i}|`).join("");
    expect(result).toBe(expected);
  });

  it("accumulateStreamedTools: many invocations each redelivered multiple times out of order collapse to one entry per invocation, at first-seen order, holding the highest-index status", () => {
    const N = 200;
    const parts: ToolStreamPart[] = [];
    for (let i = 0; i < N; i++) {
      const id = `tool-${i}`;
      // Each invocation redelivered 3x (DISPATCHING -> RUNNING -> COMPLETED)
      // at indices that interleave across invocations, not grouped by id.
      parts.push({ index: i * 3, type: "tool", toolInvocationId: id, name: "crop_image", status: "DISPATCHING" });
      parts.push({ index: i * 3 + 1, type: "tool", toolInvocationId: id, name: "crop_image", status: "RUNNING" });
      parts.push({ index: i * 3 + 2, type: "tool", toolInvocationId: id, name: "crop_image", status: "COMPLETED" });
    }
    const shuffled = [...parts].sort(() => Math.random() - 0.5);

    const result = accumulateStreamedTools(shuffled);
    expect(result).toHaveLength(N);
    // First-seen order is by ascending id (tool-0 dispatched before tool-1, ...).
    expect(result.map((t) => t.toolInvocationId)).toEqual(Array.from({ length: N }, (_, i) => `tool-${i}`));
    // Every invocation resolved to its highest-index (COMPLETED) part, never a stale earlier status.
    expect(result.every((t) => t.status === "COMPLETED")).toBe(true);
  });
});

function creditApprovalWaitpoint(overrides: Partial<WaitpointDTO> = {}): WaitpointDTO {
  return {
    id: "wp1",
    agentRunId: "run1",
    kind: "CREDIT_APPROVAL",
    status: "PENDING",
    requestPayload: {
      calls: [{ toolCallId: "call_1", toolName: "gpt_image_2", estimatedCredits: 0.1 }],
      estimatedCredits: 0.1,
      threshold: 0.08,
    },
    resolvedPayload: null,
    expiresAt: "2026-08-21T21:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  } as WaitpointDTO;
}

function clarificationWaitpoint(overrides: Partial<WaitpointDTO> = {}): WaitpointDTO {
  return {
    id: "wp2",
    agentRunId: "run1",
    kind: "CLARIFICATION",
    status: "PENDING",
    requestPayload: { question: "Which image should I edit?" },
    resolvedPayload: null,
    expiresAt: "2026-08-21T21:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  } as WaitpointDTO;
}

function waitpointPart(index: number, waitpoint: WaitpointDTO): TurnStreamPart {
  return { type: "waitpoint", index, waitpoint } as unknown as TurnStreamPart;
}

describe("latestWaitpointFromStream", () => {
  it("returns null for an empty parts array", () => {
    expect(latestWaitpointFromStream([])).toBeNull();
  });

  it("returns null when parts contains only non-waitpoint parts", () => {
    const parts: TurnStreamPart[] = [{ index: 0, type: "text", delta: "hello" }];
    expect(latestWaitpointFromStream(parts)).toBeNull();
  });

  it("returns the single waitpoint part's waitpoint when there's exactly one", () => {
    const wp = creditApprovalWaitpoint();
    const parts: TurnStreamPart[] = [waitpointPart(0, wp)];
    expect(latestWaitpointFromStream(parts)).toEqual(wp);
  });

  it("returns the higher-index waitpoint when two appear in ascending array order", () => {
    const wp0 = creditApprovalWaitpoint({ id: "wp-a" });
    const wp1 = clarificationWaitpoint({ id: "wp-b" });
    const parts: TurnStreamPart[] = [waitpointPart(0, wp0), waitpointPart(1, wp1)];
    expect(latestWaitpointFromStream(parts)).toEqual(wp1);
  });

  it("returns the higher-index waitpoint even when it appears FIRST in the array (highest index wins, not last-in-array)", () => {
    const wpHigh = clarificationWaitpoint({ id: "wp-high" });
    const wpLow = creditApprovalWaitpoint({ id: "wp-low" });
    const parts: TurnStreamPart[] = [waitpointPart(5, wpHigh), waitpointPart(2, wpLow)];
    expect(latestWaitpointFromStream(parts)).toEqual(wpHigh);
  });

  it("has NO status precedence: a higher-index COMPLETED waitpoint wins over a lower-index PENDING one that appears later in the array — intentional per the function's own doc comment (max-by-index, not 'prefer PENDING'); callers (use-active-run.ts) are responsible for status-aware handling on top of this", () => {
    const completedHigh = creditApprovalWaitpoint({ id: "wp-completed", status: "COMPLETED" });
    const pendingLow = clarificationWaitpoint({ id: "wp-pending", status: "PENDING" });
    // Lower index (1) appears LAST in the array; higher index (3) appears FIRST.
    const parts: TurnStreamPart[] = [waitpointPart(3, completedHigh), waitpointPart(1, pendingLow)];
    expect(latestWaitpointFromStream(parts)).toEqual(completedHigh);
  });

  it("skips non-waitpoint parts while tracking the max across a mixed, realistic stream", () => {
    const clarification = clarificationWaitpoint({ id: "wp-clarify" });
    const creditApproval = creditApprovalWaitpoint({ id: "wp-credit" });
    const parts: TurnStreamPart[] = [
      { index: 0, type: "text", delta: "Before. " },
      waitpointPart(2, clarification),
      { index: 3, type: "text", delta: "After. " },
      waitpointPart(5, creditApproval),
    ];
    expect(latestWaitpointFromStream(parts)).toEqual(creditApproval);
  });

  it("normalizes a legacy pre-2026-08-29 requestPayload shape ({toolName, estimatedCredits, threshold}, no `calls` array) via CreditApprovalRequestPayloadSchema's preprocess upgrade, rather than returning null or throwing", () => {
    const legacyWaitpoint = {
      id: "wp-legacy",
      agentRunId: "run1",
      kind: "CREDIT_APPROVAL",
      status: "PENDING",
      requestPayload: { toolName: "gpt_image_2", estimatedCredits: 0.1, threshold: 0.08 },
      resolvedPayload: null,
      expiresAt: "2026-08-21T21:00:00.000Z",
      resolvedAt: null,
    };
    const parts: TurnStreamPart[] = [waitpointPart(0, legacyWaitpoint as unknown as WaitpointDTO)];
    const result = latestWaitpointFromStream(parts);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("CREDIT_APPROVAL");
    const payload = (result as Extract<WaitpointDTO, { kind: "CREDIT_APPROVAL" }>).requestPayload;
    expect(Array.isArray(payload.calls)).toBe(true);
    expect(payload.calls).toHaveLength(1);
    expect(payload.calls[0]).toMatchObject({ toolName: "gpt_image_2", estimatedCredits: 0.1 });
    expect(payload.estimatedCredits).toBe(0.1);
    expect(payload.threshold).toBe(0.08);
  });

  it("silently skips a genuinely malformed waitpoint (missing required fields / unrecognized kind) and returns null rather than throwing", () => {
    const garbage = { id: "wp-garbage", kind: "NOT_A_REAL_KIND", status: "PENDING" };
    const parts: TurnStreamPart[] = [waitpointPart(0, garbage as unknown as WaitpointDTO)];
    expect(() => latestWaitpointFromStream(parts)).not.toThrow();
    expect(latestWaitpointFromStream(parts)).toBeNull();
  });

  it("falls back to a lower-index valid waitpoint when a higher-index part is malformed, instead of returning null", () => {
    const valid = creditApprovalWaitpoint({ id: "wp-valid" });
    const garbage = { id: "wp-garbage", kind: "NOT_A_REAL_KIND", status: "PENDING" };
    const parts: TurnStreamPart[] = [waitpointPart(0, valid), waitpointPart(1, garbage as unknown as WaitpointDTO)];
    expect(latestWaitpointFromStream(parts)).toEqual(valid);
  });
});
