/**
 * S6 structured logging (.claude/specs/S6-reliability-implementation-plan.md
 * §7.5). Assignment §11 "Logs" requirement: structured logs carrying
 * chatId, runId, messageId, traceId, processId, and waitpointTokenId where
 * applicable. Before this file, the backend had zero structured logging (6
 * raw console.* calls total, no logger module).
 *
 * Two delegation paths, one call shape:
 *  - Inside a Trigger.dev task, the SDK's own `logger` already ships
 *    structured, run-scoped logging (visible in the Trigger.dev dashboard
 *    per-run) — delegate to it rather than inventing a second mechanism.
 *  - Inside a Next.js Route Handler (no Trigger.dev task context), there is
 *    no equivalent — emit structured JSON via console so log aggregation
 *    (or a human reading stdout) can still parse fields out.
 *
 * `processId` is always `process.pid` — the same process value in both
 * paths, since both run in the same Node process (Trigger.dev's local/
 * hosted worker or the Next.js server process).
 */
import { logger as triggerLogger } from "@trigger.dev/sdk";

export type LogFields = {
  chatId?: string;
  runId?: string;
  messageId?: string;
  traceId?: string;
  waitpointTokenId?: string;
  [key: string]: unknown;
};

function withProcessId(fields: LogFields): LogFields & { processId: number } {
  return { ...fields, processId: process.pid };
}

/**
 * True while running inside a Trigger.dev task (the SDK sets this up
 * per-task; calling logger.* outside a task context is a documented no-op
 * that also prints a console warning on some SDK versions, so we route
 * around it explicitly rather than relying on the SDK to no-op silently).
 */
function inTriggerTaskContext(): boolean {
  // Re-verified against the installed @trigger.dev/sdk 4.5.11 (S7 plan
  // §4.9): its public surface exports `Context`/`TaskRunContext` as *types*
  // only and no runtime accessor for "the current run context" — `ctx` is
  // reachable solely as an argument to a task's own `run`. So an env-var
  // signal remains the only available heuristic from a shared module.
  //
  // It is deliberately safe to get wrong. A false negative (the vars are
  // absent inside a task) falls through to the console-JSON path below,
  // which Trigger.dev captures as task stdout and still surfaces per-run in
  // the dashboard — structured and visible, just not attached to the SDK
  // logger's own attributes. A false positive is impossible in practice
  // (nothing outside a worker sets these). The one outcome this must never
  // have — a log line going nowhere — cannot occur, because the fallback is
  // the always-visible path, not the silent one.
  return typeof process.env.TRIGGER_TASK_RUN_ID === "string" || typeof process.env.TRIGGER_RUN_ID === "string";
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const withPid = withProcessId(fields);
  if (inTriggerTaskContext()) {
    triggerLogger[level](event, withPid);
    return;
  }
  // Structured JSON on a single line — parseable by any log aggregator,
  // readable by a human via `| jq` in local dev.
  const line = JSON.stringify({ level, event, ...withPid, timestamp: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};
