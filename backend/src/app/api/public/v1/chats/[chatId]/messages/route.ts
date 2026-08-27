import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import {
  badRequest,
  conflict,
  insufficientCredits,
  notFound,
  publicHandleOptions,
  publicJson,
  serverError,
  tooManyRequests,
} from "@/lib/http";
import { CreateMessageRequestSchema, ListMessagesQuerySchema, ListMessagesResponseSchema } from "@/contracts/messages";
import { SendTurnResponseSchema } from "@/contracts/runs";
import { toPublicSendTurnResponse } from "@/public-api/mappers";
import { getOwnedChat } from "@/services/chats";
import { listMessages } from "@/services/messages";
import { createTurn, findTurnByIdempotencyKey, ActiveRunExistsError, InsufficientCreditsError } from "@/services/send-turn";
import { AttachmentBindError } from "@/services/attachments";
import { toAgentRunDTO } from "@/services/runs";
import { checkAndIncrementRateLimit, RateLimitedError } from "@/services/rate-limit";
import { resolveRequestedModel } from "@/lib/model-selection";
import { dispatchAgentTurn, ASSISTANT_STREAM_KEY } from "@/server/dispatch";
import { finalizeFailed } from "@/server/agent/persist";
import { prisma } from "@/lib/db";

export function OPTIONS() {
  return publicHandleOptions();
}

function rateLimitHeaders(state: { limit: number; remaining: number; resetAt: Date }): HeadersInit {
  const resetEpochSeconds = Math.ceil(state.resetAt.getTime() / 1000);
  return {
    "X-RateLimit-Limit": String(state.limit),
    "X-RateLimit-Remaining": String(state.remaining),
    "X-RateLimit-Reset": String(resetEpochSeconds),
  };
}

function tooManyRequestsWithHeaders(error: RateLimitedError): Response {
  const res = tooManyRequests(error.message, "public");
  const retryAfterSeconds = Math.max(1, Math.ceil((error.resetAt.getTime() - Date.now()) / 1000));
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(rateLimitHeaders(error))) headers.set(key, value);
  headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Public mirror of /api/v1/chats/{chatId}/messages — same Turn Lifecycle
 * (validate -> rate-limit -> admit credit -> persist -> dispatch -> return),
 * reusing the identical src/services/* functions. Differences from the
 * internal route: api-key auth + scopes, public CORS, an Idempotency-Key
 * replay path, and a stream pointer instead of a raw Trigger.dev token
 * (see src/public-api/mappers.ts).
 */
export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "runs:write");
  if (scopeErr) return scopeErr;

  const { chatId } = await params;
  if (!(await getOwnedChat(auth.userId, chatId))) return notFound("public");

  const parsed = CreateMessageRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid message.", parsed.error.flatten(), "public");

  // Idempotent replay: a retrying client presenting the same Idempotency-Key
  // for this chat gets back the original turn's current state, never a
  // second message/run/credit charge.
  const idempotencyKeyHeader = req.headers.get("Idempotency-Key") ?? undefined;
  if (idempotencyKeyHeader) {
    const existing = await findTurnByIdempotencyKey(chatId, idempotencyKeyHeader);
    if (existing) {
      return publicJson(
        toPublicSendTurnResponse(
          SendTurnResponseSchema.parse({
            chatId,
            message: existing.message,
            run: toAgentRunDTO(existing.run),
            // Replay never re-mints realtime access — toPublicSendTurnResponse
            // strips this field anyway, replacing it with the stream pointer.
            realtime: { runId: existing.run.triggerRunId ?? "", streamKey: ASSISTANT_STREAM_KEY, accessToken: "", expiresAt: new Date(0).toISOString() },
          }),
        ),
        201,
      );
    }
  }

  // Rate-limited by the api-key's own bucket (Clerk's `AuthenticatedMachineObject.id`,
  // confirmed distinct from `auth.subject`/clerkUserId against the installed
  // `@clerk/backend` APIKey resource type) so one abusive key can't throttle
  // the same human's browser session, and two keys of one user throttle
  // independently. Falls back to clerkUserId only for a session_token caller
  // (this route accepts one because `requireScopes` lets full-implicit-scope
  // session tokens through) — that path shares the first-party app's bucket,
  // which is the existing, unchanged behavior for that tokenType.
  let rateLimitState;
  try {
    rateLimitState = await checkAndIncrementRateLimit(auth.identity.apiKeyId ?? auth.identity.clerkUserId);
  } catch (error) {
    if (error instanceof RateLimitedError) return tooManyRequestsWithHeaders(error);
    throw error;
  }

  const requestedModel = resolveRequestedModel(parsed.data.model);

  let created: Awaited<ReturnType<typeof createTurn>>;
  try {
    created = await createTurn({
      chatId,
      userId: auth.userId,
      content: parsed.data.content,
      attachmentIds: parsed.data.attachments.map((a) => a.id),
      requestedModel,
      externalIdempotencyKey: idempotencyKeyHeader,
    });
  } catch (error) {
    if (error instanceof ActiveRunExistsError) return conflict(error.message, undefined, "public");
    if (error instanceof InsufficientCreditsError) return insufficientCredits(undefined, "public");
    if (error instanceof AttachmentBindError) return badRequest(error.message, undefined, "public");
    throw error;
  }

  const { message, run } = created;

  let triggerRunId: string;
  try {
    ({ triggerRunId } = await dispatchAgentTurn({
      runId: run.id,
      chatId,
      userMessageId: message.id,
      userId: auth.userId,
      requestedModel,
    }));
  } catch {
    await finalizeFailed({
      runId: run.id,
      assistantMessageId: null,
      errorCode: "dispatch_failed",
      errorMessage: "Could not start the response. Please try again.",
      fromStatus: "queued",
    });
    return serverError("Could not start the response. Please try again.", "public");
  }

  try {
    await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } });
  } catch {
    try {
      await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } });
    } catch (error) {
      console.error(
        `[public-send-turn] failed to persist triggerRunId for run ${run.id} after dispatch succeeded (triggerRunId=${triggerRunId})`,
        error,
      );
    }
  }

  // No Trigger.dev realtime token is minted here — toPublicSendTurnResponse
  // strips `realtime` entirely and replaces it with our own stream pointer
  // (Phase 4 re-emits Trigger.dev Realtime server-side; a public caller
  // never receives the Trigger token, see mappers.ts). Placeholder values
  // below are discarded by the mapper, never returned to the client.
  const body = publicJson(
    toPublicSendTurnResponse(
      SendTurnResponseSchema.parse({
        chatId,
        message,
        run: toAgentRunDTO({ ...run, triggerRunId }),
        realtime: { runId: triggerRunId, streamKey: ASSISTANT_STREAM_KEY, accessToken: "", expiresAt: new Date(0).toISOString() },
      }),
    ),
    201,
  );
  const headers = new Headers(body.headers);
  for (const [key, value] of Object.entries(rateLimitHeaders(rateLimitState))) headers.set(key, value);
  return new Response(body.body, { status: body.status, headers });
}

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeErr = requireScopes(auth.identity, "chats:read");
  if (scopeErr) return scopeErr;

  const { chatId } = await params;
  if (!(await getOwnedChat(auth.userId, chatId))) return notFound("public");

  const url = new URL(req.url);
  const parsed = ListMessagesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten(), "public");

  const page = await listMessages(chatId, parsed.data);
  return publicJson(ListMessagesResponseSchema.parse(page));
}
