import { authenticate } from "@/lib/auth";
import { handleOptions, json, notFound } from "@/lib/http";
import { AgentRunDTOSchema } from "@/contracts/runs";
import { getOwnedRun, reconcileIfStale, toAgentRunDTO } from "@/services/runs";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { toWaitpointDTO } from "@/services/waitpoints";
import { prisma } from "@/lib/db";

export function OPTIONS() {
  return handleOptions();
}

/**
 * REST fallback / recovery interface for an in-progress run (assignment
 * §9 "Reconnect"/"Reload Recovery" — realtime is strictly an optimization
 * over this, never the only path to state; 00-master-spec.md §5).
 * Reconciles a stale non-terminal run before responding (S2 implementation
 * plan §F) so a dead run is never reported as still active.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound();

  const reconciled = await reconcileIfStale(run);
  const toolInvocations = await listToolInvocationDTOs(reconciled.id);
  // S6 (§7.1) — reload-recovery for an in-progress approval/clarification,
  // same pattern as toolInvocations above.
  const pendingWaitpointRow = await prisma.waitpoint.findFirst({
    where: { agentRunId: reconciled.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  const pendingWaitpoint = pendingWaitpointRow ? toWaitpointDTO(pendingWaitpointRow) : null;
  return json(AgentRunDTOSchema.parse(toAgentRunDTO(reconciled, toolInvocations, pendingWaitpoint)));
}
