import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { notFound, publicHandleOptions, publicJson } from "@/lib/http";
import { AgentRunDTOSchema } from "@/contracts/runs";
import { getOwnedRun, toAgentRunDTO, verifyAgainstTrigger } from "@/services/runs";
import { finalizeCancelled } from "@/server/agent/persist";
import { cancelTriggerRun } from "@/server/dispatch";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { prisma } from "@/lib/db";
import { log } from "@/lib/logger";

export function OPTIONS() {
  return publicHandleOptions();
}

/** Public mirror of POST /api/v1/runs/{runId}/cancel — same idempotent Stop semantics. */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "runs:write");
  if (scopeErr) return scopeErr;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound("public");

  const traceId = crypto.randomUUID();
  log.info("run.cancel_requested", {
    runId: run.id,
    chatId: run.chatId,
    messageId: run.assistantMessageId ?? undefined,
    traceId,
    fromStatus: run.status,
    source: "public_api",
  });

  if (run.status !== "queued" && run.status !== "running" && run.status !== "waiting") {
    const toolInvocations = await listToolInvocationDTOs(run.id);
    return publicJson(AgentRunDTOSchema.parse(toAgentRunDTO(run, toolInvocations)));
  }

  if (run.triggerRunId) {
    await cancelTriggerRun(run.triggerRunId).catch(() => {
      // Best-effort — our own DB transition below is the source of truth.
    });
  }

  if (run.status === "queued") {
    const cancelled = await finalizeCancelled({
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
      fromStatus: "queued",
      chatId: run.chatId,
      traceId,
    });
    if (!cancelled) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: { in: ["running", "waiting"] } },
        data: { cancelRequestedAt: new Date() },
      });
    }
  } else {
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: run.status },
      data: { cancelRequestedAt: new Date() },
    });
  }

  const afterCancelRequest = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
  const refreshed = await verifyAgainstTrigger(afterCancelRequest);
  const toolInvocations = await listToolInvocationDTOs(refreshed.id);
  return publicJson(AgentRunDTOSchema.parse(toAgentRunDTO(refreshed, toolInvocations)));
}
