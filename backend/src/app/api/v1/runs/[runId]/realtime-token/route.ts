import { authenticate } from "@/lib/auth";
import { badRequest, handleOptions, json, notFound } from "@/lib/http";
import { RealtimeAccessSchema } from "@/contracts/runs";
import { getOwnedRun } from "@/services/runs";
import { mintRealtimeToken, ASSISTANT_STREAM_KEY } from "@/server/dispatch";

export function OPTIONS() {
  return handleOptions();
}

/**
 * Mandatory token-refresh route (00-master-spec.md §8 — `auth.
 * createPublicToken`'s default expiry is short relative to a full agent
 * turn; this is the mechanism satisfying the assignment's "reconnect with
 * ... token refresh" requirement, not a polish item). Ownership-checked
 * through AgentRun -> Chat.ownerId like every other run/chat resource.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound();

  if (!run.triggerRunId) {
    // Dispatch hasn't been confirmed yet — nothing to scope a token to.
    return badRequest("This run has not started streaming yet.");
  }

  const { accessToken, expiresAt } = await mintRealtimeToken(run.triggerRunId);
  return json(
    RealtimeAccessSchema.parse({
      runId: run.triggerRunId,
      streamKey: ASSISTANT_STREAM_KEY,
      accessToken,
      expiresAt: expiresAt.toISOString(),
    }),
  );
}
