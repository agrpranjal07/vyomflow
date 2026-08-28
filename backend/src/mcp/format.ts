/**
 * S8 Phase 5 — shapes a `WaitOutcome` (src/mcp/wait.ts) into the MCP tool
 * result both `vyomflow_send_message` and `vyomflow_wait_for_run` return.
 * The wire content is a single JSON text block: MCP clients read `content[0]`
 * as free text handed to the model, so the payload here is exactly what the
 * spec's `-> { runId, messageId, status, cursor, text, tools, ... }` shape
 * requires, plus an actionable instruction string when a waitpoint is
 * pending (no MCP elicitation — client support is inconsistent, per plan).
 */
import type { WaitOutcome } from "@/mcp/wait";

export function waitpointInstruction(outcome: WaitOutcome): string | undefined {
  const wp = outcome.pendingWaitpoint;
  if (!wp) return undefined;
  if (wp.kind === "CREDIT_APPROVAL") {
    const { calls, estimatedCredits, threshold } = wp.requestPayload;
    const summary =
      calls.length === 1
        ? `${calls[0].toolName} (${calls[0].estimatedCredits} credits)`
        : calls.map((c) => `${c.toolName} (${c.estimatedCredits} credits)`).join(", ");
    return (
      `Approval required for ${summary} — total ${estimatedCredits} credits, threshold ${threshold}. Call ` +
      `vyomflow_respond_waitpoint({ waitpointId: '${wp.id}', kind: 'CREDIT_APPROVAL', approved: true|false }) ` +
      `before ${wp.expiresAt}.`
    );
  }
  const options = wp.requestPayload.options?.length ? ` Options: ${wp.requestPayload.options.join(", ")}.` : "";
  return (
    `Clarification required: "${wp.requestPayload.question}".${options} Call ` +
    `vyomflow_respond_waitpoint({ waitpointId: '${wp.id}', kind: 'CLARIFICATION', answer: '<your answer>' }) ` +
    `before ${wp.expiresAt}.`
  );
}

export function toolResultFromWait(outcome: WaitOutcome, extra: Record<string, unknown> = {}) {
  const instruction = waitpointInstruction(outcome);
  const payload = {
    runId: outcome.run.id,
    status: outcome.run.status,
    cursor: outcome.cursor,
    text: outcome.text,
    tools: outcome.tools,
    pendingWaitpoint: outcome.pendingWaitpoint,
    done: outcome.done,
    ...(instruction ? { instruction } : {}),
    ...extra,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
