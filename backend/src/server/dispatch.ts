/**
 * Thin, mockable seam between the send Route Handler and Trigger.dev — kept
 * as its own module so integration tests can `vi.mock` this file and never
 * reach the Trigger.dev cloud (S2 implementation plan §J).
 *
 * Idempotency: `idempotencyKeys.create(key, { scope: "global" })`, not the
 * bare-string / "run"-scope default. Verified against the installed
 * @trigger.dev/sdk 4.5.11 types (TriggerOptions' own doc comment): a raw
 * string passed as `idempotencyKey` is documented as "the same as a global
 * idempotency key", and `.create()`'s default "run" scope is combined with
 * a *parent run's* id — meaningless from an HTTP Route Handler, which has
 * no parent run. Being explicit here is safer than depending on either of
 * those implicit behaviors. This is the correct scope for *this* call site
 * specifically — the LOCKED architecture note's `scope: run` still applies
 * unchanged to S3's child-task (`triggerAndWait`) dispatch, which *does*
 * run inside a parent task.
 */
import { tasks, idempotencyKeys, auth, runs } from "@trigger.dev/sdk";
import type { agentTurn, AgentTurnPayload } from "@/trigger/turn";
import { ASSISTANT_STREAM_KEY } from "@/trigger/streams";
import { REALTIME_TOKEN_TTL_MS, REALTIME_TOKEN_TTL_DURATION, TRIGGER_RETRIEVE_TIMEOUT_MS } from "@/lib/config";

export interface DispatchResult {
  triggerRunId: string;
  accessToken: string;
}

export async function dispatchAgentTurn(payload: AgentTurnPayload): Promise<DispatchResult> {
  const idempotencyKey = await idempotencyKeys.create(`send:${payload.chatId}:${payload.userMessageId}`, {
    scope: "global",
  });

  const handle = await tasks.trigger<typeof agentTurn>("agent-turn", payload, {
    idempotencyKey,
    idempotencyKeyTTL: "30d",
    // Forks the task's declared "agent-turn" queue per user, so the
    // AGENT_TURN_QUEUE_CONCURRENCY limit is a per-user fairness bound
    // rather than a global ceiling one user could occupy alone.
    concurrencyKey: payload.userId,
  });

  return { triggerRunId: handle.id, accessToken: handle.publicAccessToken };
}

/**
 * Mints a fresh, scoped public access token for realtime reconnect (S2
 * mandatory token-refresh route). `expirationTime` is always passed
 * explicitly — the SDK's default is not verifiable from the shipped types,
 * so nothing relies on it.
 */
export async function mintRealtimeToken(triggerRunId: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const accessToken = await auth.createPublicToken({
    scopes: { read: { runs: [triggerRunId] } },
    expirationTime: REALTIME_TOKEN_TTL_DURATION,
  });
  return { accessToken, expiresAt: new Date(Date.now() + REALTIME_TOKEN_TTL_MS) };
}

export async function cancelTriggerRun(triggerRunId: string): Promise<void> {
  // Idempotent on an already-terminal run per docs. Same bounded-race
  // pattern as reconcileIfStale (src/services/runs.ts) — the installed
  // SDK's ApiRequestOptions has no per-call signal/timeout, so a hung
  // request here would otherwise stall the whole POST /cancel route
  // indefinitely instead of just degrading to the caller's best-effort
  // catch.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    runs.cancel(triggerRunId),
    new Promise<void>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error("Trigger.dev cancel request timed out.")), TRIGGER_RETRIEVE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(deadlineTimer));
}

export { ASSISTANT_STREAM_KEY };
