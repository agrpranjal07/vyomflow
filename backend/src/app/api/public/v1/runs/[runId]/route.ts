import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { notFound, publicHandleOptions, publicJson } from "@/lib/http";
import { AgentRunDTOSchema } from "@/contracts/runs";
import { getOwnedRun, reconcileIfStale, toAgentRunDTO } from "@/services/runs";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { toWaitpointDTO } from "@/services/waitpoints";
import { prisma } from "@/lib/db";

export function OPTIONS() {
  return publicHandleOptions();
}

/** Public mirror of GET /api/v1/runs/{runId} — REST fallback/recovery for an in-progress run, same reconcile-before-read behavior. */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "runs:read");
  if (scopeErr) return scopeErr;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound("public");

  const reconciled = await reconcileIfStale(run);
  const toolInvocations = await listToolInvocationDTOs(reconciled.id);
  const pendingWaitpointRow = await prisma.waitpoint.findFirst({ where: { agentRunId: reconciled.id, status: "PENDING" } });
  const pendingWaitpoint = pendingWaitpointRow ? toWaitpointDTO(pendingWaitpointRow) : null;
  return publicJson(AgentRunDTOSchema.parse(toAgentRunDTO(reconciled, toolInvocations, pendingWaitpoint)));
}
