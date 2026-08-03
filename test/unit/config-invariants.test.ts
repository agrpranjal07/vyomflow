import { describe, it, expect } from "vitest";
import {
  AGENT_TURN_MAX_DURATION_S,
  MEDIA_TOOL_TASK_MAX_DURATION_S,
  MEDIA_TOOL_EXEC_DEADLINE_MS,
  TRANSLOADIT_POLL_DEADLINE_MS,
  TOOL_ORPHAN_TIMEOUT_MS,
} from "@/lib/config";

// S7 debt closure (§2.1/§9.5 T35, S6's own T29): the agent-turn task's own
// maxDuration must stay strictly greater than the media-tool child task's
// maxDuration (src/trigger/turn.ts's audit item 22 comment) — a single slow
// tool dispatch must never be able to time out the parent turn before the
// child itself gives up. Holds by construction today
// (AGENT_TURN_MAX_DURATION_S = MEDIA_TOOL_TASK_MAX_DURATION_S + 60), so this
// is a cheap guard against a future edit to either constant silently
// reintroducing the drift S6 fixed.
describe("config — agent-turn vs. media-tool maxDuration relationship", () => {
  it("AGENT_TURN_MAX_DURATION_S is strictly greater than MEDIA_TOOL_TASK_MAX_DURATION_S", () => {
    expect(AGENT_TURN_MAX_DURATION_S).toBeGreaterThan(MEDIA_TOOL_TASK_MAX_DURATION_S);
  });

  // S7 H1 (recorded in config.ts's MEDIA_TOOL_TASK_MAX_DURATION_S comment):
  // a slow tool execution plus its own asset upload must both fit inside the
  // task's own maxDuration budget, or a success landing late in its exec
  // window could have the task killed mid-ingestion, losing an
  // already-paid-for result with no retry (maxAttempts: 1). Never previously
  // asserted explicitly.
  it("MEDIA_TOOL_TASK_MAX_DURATION_S budgets for exec + Transloadit ingestion", () => {
    expect(MEDIA_TOOL_TASK_MAX_DURATION_S * 1000).toBeGreaterThanOrEqual(
      MEDIA_TOOL_EXEC_DEADLINE_MS + TRANSLOADIT_POLL_DEADLINE_MS,
    );
  });

  // Phase 6 review finding: ToolInvocation.updatedAt is only bumped at the
  // RUNNING transition, not on a heartbeat, so the orphan sweep must never
  // fire before a legitimately-still-executing media-tool task's own
  // maxDuration could plausibly elapse — otherwise the sweep marks a
  // still-running tool FAILED/orphaned while it's genuinely in flight, and
  // its eventual real completion settles a row that's already terminal.
  it("TOOL_ORPHAN_TIMEOUT_MS is strictly greater than MEDIA_TOOL_TASK_MAX_DURATION_S", () => {
    expect(TOOL_ORPHAN_TIMEOUT_MS).toBeGreaterThan(MEDIA_TOOL_TASK_MAX_DURATION_S * 1000);
  });
});
