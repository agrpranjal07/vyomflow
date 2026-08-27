/**
 * S8 Phase 5 — the MCP server's bounded long-poll. `send_message` and
 * `wait_for_run` both funnel through this: subscribe to the run's realtime
 * stream server-side for at most `waitSeconds` (clamped well under Vercel's
 * 300s ceiling and under a typical MCP client's own JSON-RPC timeout), then
 * re-read the DB as the authoritative snapshot. Never blocks to completion —
 * `AGENT_TURN_MAX_DURATION_S` (450s) and `WAITPOINT_TIMEOUT_MS` (10min) both
 * exceed any one HTTP request's budget, so a client that wants the full turn
 * calls `vyomflow_wait_for_run` again with the returned `cursor`.
 *
 * Uses `streams.read` directly against Trigger.dev Realtime (not our own SSE
 * re-emission from Phase 4) — this runs server-side in the same process that
 * dispatches the turn, so there is no public-token/CORS concern here at all.
 */
import { streams } from "@trigger.dev/sdk";
import { ASSISTANT_STREAM_KEY } from "@/trigger/streams";
import type { TurnStreamPart } from "@/contracts/runs";
import type { AgentRunDTO, AgentRunStatus } from "@/contracts/runs";
import type { WaitpointDTO } from "@/contracts/waitpoints";
import { getOwnedRun, reconcileIfStale, toAgentRunDTO } from "@/services/runs";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { toWaitpointDTO } from "@/services/waitpoints";
import { prisma } from "@/lib/db";

/** Hard clamp on `waitSeconds` — comfortably under Vercel's 300s function ceiling and under every MCP client's own JSON-RPC timeout. */
export const MCP_WAIT_MAX_S = 55;
export const MCP_WAIT_DEFAULT_S = 30;

export function clampWaitSeconds(input: number | undefined): number {
  const v = input ?? MCP_WAIT_DEFAULT_S;
  if (!Number.isFinite(v)) return MCP_WAIT_DEFAULT_S;
  return Math.min(Math.max(Math.trunc(v), 0), MCP_WAIT_MAX_S);
}

/** One entry per `ToolInvocation`, ordered by `(turnIndex, callIndex)` — the plan's explicit ban on a singular `currentTool` field. */
export interface ToolProgress {
  toolInvocationId: string;
  name: string;
  status: string;
  turnIndex: number;
  callIndex: number;
  creditUsed?: number;
  resultUrls?: string[];
  errorMessage?: string;
}

export interface WaitOutcome {
  run: AgentRunDTO;
  text: string;
  tools: ToolProgress[];
  pendingWaitpoint: WaitpointDTO | null;
  cursor: number;
  done: boolean;
}

function isTerminal(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** A human-readable progress line — never a single `currentTool` field, per the plan's parallel-tool requirement. */
function progressMessage(active: ToolProgress[], fallback: string): string {
  if (active.length === 0) return fallback;
  if (active.length === 1) return `${active[0].name}: ${active[0].status}`;
  return `${active.length} tools running: ${active.map((t) => t.name).join(", ")}`;
}

/**
 * Bounded server-side wait on one run. `triggerRunIdOverride` is passed by
 * `send_message`, which already has the freshly-dispatched Trigger run id in
 * hand and must not race the DB write that persists it (mirrors the same gap
 * the internal send route's own `triggerRunId` patch-after-dispatch has).
 */
export async function waitForRun(params: {
  userId: string;
  runId: string;
  fromIndex: number;
  waitSeconds: number;
  triggerRunIdOverride?: string;
  signal?: AbortSignal;
  notify?: (progress: number, message: string) => Promise<void> | void;
}): Promise<WaitOutcome | null> {
  const { userId, runId, fromIndex, waitSeconds, triggerRunIdOverride, signal, notify } = params;

  const owned = await getOwnedRun(userId, runId);
  if (!owned) return null;
  const run = await reconcileIfStale(owned);

  const triggerRunId = triggerRunIdOverride ?? run.triggerRunId;
  let text = "";
  let cursor = fromIndex > 0 ? fromIndex - 1 : -1;
  const toolParts = new Map<string, { name: string; status: string; creditUsed?: number; resultUrls?: string[]; errorMessage?: string }>();

  const shouldWait = !isTerminal(run.status) && run.status !== "waiting" && !!triggerRunId && waitSeconds > 0;

  if (shouldWait) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    const deadline = setTimeout(() => controller.abort(), waitSeconds * 1000);
    try {
      const stream = await streams.read<TurnStreamPart>(triggerRunId, ASSISTANT_STREAM_KEY, {
        startIndex: fromIndex,
        signal: controller.signal,
        timeoutInSeconds: waitSeconds,
      });
      for await (const part of stream) {
        cursor = Math.max(cursor, part.index);
        if (part.type === "text" && part.channel === "text") {
          text += part.delta;
        } else if (part.type === "tool") {
          toolParts.set(part.toolInvocationId, {
            name: part.name,
            status: part.status,
            creditUsed: part.creditUsed,
            resultUrls: part.resultUrls,
            errorMessage: part.errorMessage,
          });
          if (notify) {
            const active = [...toolParts.entries()]
              .filter(([, v]) => v.status === "DISPATCHING" || v.status === "QUEUED" || v.status === "RUNNING")
              .map(([id, v]) => ({ toolInvocationId: id, name: v.name, status: v.status, turnIndex: -1, callIndex: -1 }));
            await notify(part.index, progressMessage(active, `${part.name}: ${part.status}`));
          }
        }
      }
    } catch {
      // Timed out or aborted — expected outcome of a bounded wait, not an
      // error. Fall through to the authoritative DB re-read below.
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  const refreshed = await reconcileIfStale(row);
  const toolInvocations = await listToolInvocationDTOs(refreshed.id);
  const tools: ToolProgress[] = toolInvocations
    .map((t) => ({
      toolInvocationId: t.id,
      name: t.name,
      status: t.status,
      turnIndex: t.turnIndex,
      callIndex: t.callIndex,
      creditUsed: t.creditUsed ?? undefined,
      resultUrls: t.resultUrls ?? undefined,
      errorMessage: t.errorMessage ?? undefined,
    }))
    .sort((a, b) => a.turnIndex - b.turnIndex || a.callIndex - b.callIndex);

  const pendingWaitpointRow = await prisma.waitpoint.findFirst({ where: { agentRunId: refreshed.id, status: "PENDING" } });
  const pendingWaitpoint = pendingWaitpointRow ? toWaitpointDTO(pendingWaitpointRow) : null;

  return {
    run: toAgentRunDTO(refreshed, toolInvocations, pendingWaitpoint),
    text,
    tools,
    pendingWaitpoint,
    cursor: Math.max(cursor, refreshed.lastStreamIndex),
    done: isTerminal(refreshed.status),
  };
}
