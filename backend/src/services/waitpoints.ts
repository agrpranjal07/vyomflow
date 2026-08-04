/**
 * Waitpoint lifecycle service (.claude/specs/S6-reliability-implementation-plan.md
 * §6.2/§6.2a/§6.3/§7.1) — kind-agnostic: both CREDIT_APPROVAL (backend-
 * deterministic, turn.ts's credit-threshold gate) and CLARIFICATION
 * (model-initiated via the `ask_user` tool) share this one row shape and
 * this one resume mechanism. Every write here is guarded the same way as
 * every sibling `src/services/*.ts` — a conditional UPDATE keyed on the
 * row's *current* status — so a late-arriving writer (an expiry sweep
 * racing a human response) can never resurrect or double-resolve a
 * waitpoint.
 */
import { wait } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";
import type { Prisma, Waitpoint } from "@/generated/prisma/client";
import type { WaitpointDTO, RespondToWaitpointRequest } from "@/contracts/waitpoints";

export class WaitpointNotFoundError extends Error {
  constructor() {
    super("Waitpoint not found.");
    this.name = "WaitpointNotFoundError";
  }
}

export class WaitpointKindMismatchError extends Error {
  constructor() {
    super("The response kind does not match this waitpoint's kind.");
    this.name = "WaitpointKindMismatchError";
  }
}

/** Maps a persisted row to its kind-discriminated DTO — these are our own writes, so a structural cast (matching `toToolInvocationDTO`'s own level of paranoia for its Json columns) is enough. */
export function toWaitpointDTO(row: Waitpoint): WaitpointDTO {
  const base = {
    id: row.id,
    agentRunId: row.agentRunId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
  if (row.kind === "CREDIT_APPROVAL") {
    return {
      ...base,
      kind: "CREDIT_APPROVAL",
      requestPayload: row.requestPayload as { toolName: string; estimatedCredits: number; threshold: number },
      resolvedPayload: row.resolvedPayload as { approved: boolean; respondedAt: string } | null,
    };
  }
  return {
    ...base,
    kind: "CLARIFICATION",
    requestPayload: row.requestPayload as { question: string; options?: string[] },
    resolvedPayload: row.resolvedPayload as { answer: string; respondedAt: string } | null,
  };
}

/**
 * Creates the Waitpoint row (PENDING) and transitions `AgentRun.status ->
 * "waiting"` in the same transaction (§6.3 — both kinds' lifecycle diagrams
 * do these atomically). Guarded to only apply from a non-terminal status —
 * mirrors every other status transition in this codebase.
 */
export async function createWaitpoint(
  tx: Prisma.TransactionClient,
  params: {
    runId: string;
    kind: "CREDIT_APPROVAL" | "CLARIFICATION";
    requestPayload: unknown;
    triggerTokenId: string;
    expiresAt: Date;
  },
): Promise<{ id: string }> {
  const { runId, kind, requestPayload, triggerTokenId, expiresAt } = params;

  const created = await tx.waitpoint.create({
    data: {
      agentRunId: runId,
      kind,
      requestPayload: requestPayload as Prisma.InputJsonValue,
      triggerTokenId,
      expiresAt,
    },
  });

  await tx.agentRun.updateMany({
    where: { id: runId, status: { in: ["queued", "running"] } },
    data: { status: "waiting" },
  });

  log.info("waitpoint.created", { runId, waitpointTokenId: triggerTokenId, kind });
  return { id: created.id };
}

/**
 * Ownership-checked, idempotent resume. A repeat POST on an already-
 * COMPLETED/EXPIRED waitpoint returns the current DTO with `alreadyResolved:
 * true` without touching Trigger.dev again (C17 — a repeat respond must
 * still return 200, not an error).
 */
export async function respondToWaitpoint(
  waitpointId: string,
  userId: string,
  response: RespondToWaitpointRequest,
): Promise<{ waitpoint: WaitpointDTO; alreadyResolved: boolean }> {
  const row = await prisma.waitpoint.findUnique({
    where: { id: waitpointId },
    include: { agentRun: { include: { chat: true } } },
  });
  if (!row || row.agentRun.chat.ownerId !== userId || row.agentRun.chat.deletedAt) {
    throw new WaitpointNotFoundError();
  }

  if (row.status !== "PENDING") {
    return { waitpoint: toWaitpointDTO(row), alreadyResolved: true };
  }

  // The DB's stored kind is the authority — defense in depth even though
  // the route's Zod parse against the discriminated union already rejects a
  // mismatched body shape before this is ever called.
  if (row.kind !== response.kind) {
    throw new WaitpointKindMismatchError();
  }

  const respondedAt = new Date().toISOString();
  const resolvedPayload =
    response.kind === "CREDIT_APPROVAL"
      ? { approved: response.approved, respondedAt }
      : { answer: response.answer, respondedAt };

  const updated = await prisma.$transaction((tx) =>
    tx.waitpoint.update({
      where: { id: waitpointId },
      data: {
        status: "COMPLETED",
        resolvedPayload: resolvedPayload as Prisma.InputJsonValue,
        resolvedAt: new Date(),
      },
    }),
  );

  // Our own DB transition is the source of truth; Trigger.dev's token
  // completion is best-effort follow-up (matches the cancel route's
  // `cancelTriggerRun(...).catch(() => {})` idiom) — a failure here does not
  // throw past the route. Worst case the run stays suspended until the
  // sweep's expiry path fails it closed.
  await wait.completeToken({ id: updated.triggerTokenId }, resolvedPayload).catch((error) => {
    log.warn("waitpoint.complete_token_failed", {
      runId: updated.agentRunId,
      waitpointTokenId: updated.triggerTokenId,
      kind: updated.kind,
      error: String(error),
    });
  });

  log.info("waitpoint.resolved", { runId: updated.agentRunId, waitpointTokenId: updated.triggerTokenId, kind: updated.kind });
  return { waitpoint: toWaitpointDTO(updated), alreadyResolved: false };
}

/**
 * Sweep-only (§7.3): PENDING -> EXPIRED. Returns false (no-op) if the row
 * had already resolved/expired by the time this ran — the sweep's caller is
 * responsible for releasing the hold and finalizing the run only when this
 * returns true.
 */
export async function expireWaitpoint(tx: Prisma.TransactionClient, waitpointId: string): Promise<boolean> {
  const { count } = await tx.waitpoint.updateMany({
    where: { id: waitpointId, status: "PENDING" },
    data: { status: "EXPIRED" },
  });
  if (count === 0) return false;

  const row = await tx.waitpoint.findUniqueOrThrow({ where: { id: waitpointId } });
  log.info("waitpoint.expired", { waitpointId, runId: row.agentRunId });
  return true;
}
