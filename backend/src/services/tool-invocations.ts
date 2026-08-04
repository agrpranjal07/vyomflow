/**
 * ToolInvocation row lifecycle helpers. The parent turn task (S3 commit 7)
 * creates the initial DISPATCHING row before dispatching; the media-tool
 * child task (src/trigger/tool.ts) owns every transition after that — durable UX
 * (assignment §6: "Show pending, running, completed, failed, cancelled,
 * retry, and reload-recovery states") requires the row to reflect progress
 * even before the parent resumes from `triggerAndWait`.
 */
import { prisma } from "@/lib/db";
import type { Prisma, ToolInvocation } from "@/generated/prisma/client";
import type { ToolInvocationDTO } from "@/contracts/tools";

/** Maps a persisted row to its sanitized DTO (§9 "Tool Detail" card / reload-recovery — nothing here is ever a provider secret). */
export function toToolInvocationDTO(row: ToolInvocation): ToolInvocationDTO {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    turnIndex: row.turnIndex,
    callIndex: row.callIndex,
    toolCallId: row.toolCallId,
    name: row.name,
    nodeType: row.nodeType,
    input: row.input as Record<string, unknown>,
    status: row.status,
    creditEstimate: row.creditEstimate === null ? null : Number(row.creditEstimate),
    creditUsed: row.creditUsed === null ? null : Number(row.creditUsed),
    resultUrls: (row.resultUrls as string[] | null) ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every tool invocation for a run, in deterministic emitted order (assignment §7) — reload-recovery / detail-panel readback. */
export async function listToolInvocationDTOs(agentRunId: string): Promise<ToolInvocationDTO[]> {
  const rows = await prisma.toolInvocation.findMany({
    where: { agentRunId },
    orderBy: [{ turnIndex: "asc" }, { callIndex: "asc" }],
  });
  return rows.map(toToolInvocationDTO);
}

const NON_TERMINAL_TOOL_STATUSES = ["DISPATCHING", "QUEUED", "RUNNING"] as const;

/**
 * DISPATCHING -> RUNNING, once the media-tool child task actually starts
 * executing (VyomFlow — replaces the old QUEUED/remote-run-id dispatch
 * confirmation, since in-process tools have no remote dispatch step to
 * confirm). Guarded to only apply from DISPATCHING — a late writer racing a
 * cancel/failure that already moved the row past DISPATCHING must not
 * resurrect it. Returns false when the row was no longer DISPATCHING — the
 * caller re-reads and either reports the row's
 * already-settled outcome (terminal) or fails closed with "interrupted"
 * (still RUNNING — a prior attempt died mid-execute, never re-executed).
 */
export async function markToolRunning(toolInvocationId: string): Promise<boolean> {
  const { count } = await prisma.toolInvocation.updateMany({
    where: { id: toolInvocationId, status: "DISPATCHING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return count > 0;
}

/**
 * Guarded to only apply from a non-terminal status — a late writer (e.g. a
 * stale poll result arriving after the row was already independently
 * cancelled/failed) must never flip an already-terminal row. Returns false
 * (a no-op) when the row had already settled.
 */
export async function markToolCompleted(params: {
  toolInvocationId: string;
  resultUrls: string[];
  creditUsedApp: number;
  durationMs: number;
  // S7 — Transloadit ingestion provenance/outcome. Optional so callers that
  // predate ingestion (or intentionally skip it) don't have to thread nulls
  // through explicitly.
  sourceUrls?: string[];
  assetIngestStatus?: "PENDING" | "INGESTED" | "FAILED" | "SKIPPED";
  assemblyId?: string | null;
}): Promise<boolean> {
  const { toolInvocationId, resultUrls, creditUsedApp, durationMs, sourceUrls, assetIngestStatus, assemblyId } = params;
  const { count } = await prisma.toolInvocation.updateMany({
    where: { id: toolInvocationId, status: { in: [...NON_TERMINAL_TOOL_STATUSES] } },
    data: {
      status: "COMPLETED",
      resultUrls: resultUrls as unknown as Prisma.InputJsonValue,
      creditUsed: creditUsedApp,
      durationMs,
      finishedAt: new Date(),
      ...(sourceUrls !== undefined ? { sourceUrls: sourceUrls as unknown as Prisma.InputJsonValue } : {}),
      ...(assetIngestStatus !== undefined ? { assetIngestStatus } : {}),
      ...(assemblyId !== undefined ? { assemblyId } : {}),
    },
  });
  return count > 0;
}

/** Caller-initiated cancellation (e.g. a user Stop) — a distinct terminal status from FAILED, guarded the same way. */
export async function markToolCancelled(params: { toolInvocationId: string; durationMs: number }): Promise<boolean> {
  const { toolInvocationId, durationMs } = params;
  const { count } = await prisma.toolInvocation.updateMany({
    where: { id: toolInvocationId, status: { in: [...NON_TERMINAL_TOOL_STATUSES] } },
    data: { status: "CANCELLED", errorCode: "cancelled", durationMs, finishedAt: new Date() },
  });
  return count > 0;
}

/** Same terminal-status guard as `markToolCompleted` — a late failure report must not overwrite an already-COMPLETED/CANCELLED row. */
export async function markToolFailed(params: {
  toolInvocationId: string;
  errorCode: string;
  errorMessage: string;
  creditUsedApp?: number;
  durationMs?: number;
}): Promise<boolean> {
  const { toolInvocationId, errorCode, errorMessage, creditUsedApp, durationMs } = params;
  const { count } = await prisma.toolInvocation.updateMany({
    where: { id: toolInvocationId, status: { in: [...NON_TERMINAL_TOOL_STATUSES] } },
    data: {
      status: "FAILED",
      errorCode,
      errorMessage,
      ...(creditUsedApp !== undefined ? { creditUsed: creditUsedApp } : {}),
      durationMs,
      finishedAt: new Date(),
    },
  });
  return count > 0;
}
