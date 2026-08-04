import { authenticate } from "@/lib/auth";
import {
  badRequest,
  conflict,
  handleOptions,
  insufficientCredits,
  json,
  notFound,
  realtimeUnavailable,
  serverError,
  tooManyRequests,
} from "@/lib/http";
import { CreateMessageRequestSchema, ListMessagesQuerySchema, ListMessagesResponseSchema } from "@/contracts/messages";
import { SendTurnResponseSchema } from "@/contracts/runs";
import { getOwnedChat } from "@/services/chats";
import { listMessages } from "@/services/messages";
import { createTurn, ActiveRunExistsError, InsufficientCreditsError } from "@/services/send-turn";
import { AttachmentBindError } from "@/services/attachments";
import { toAgentRunDTO } from "@/services/runs";
import { checkAndIncrementRateLimit, RateLimitedError } from "@/services/rate-limit";
import { resolveRequestedModel } from "@/lib/model-selection";
import { dispatchAgentTurn, mintRealtimeToken, ASSISTANT_STREAM_KEY } from "@/server/dispatch";
import { finalizeFailed } from "@/server/agent/persist";
import { prisma } from "@/lib/db";

export function OPTIONS() {
  return handleOptions();
}

/**
 * Send route — Turn Lifecycle (assignment §"Turn Lifecycle" /
 * S2-streaming-turn.md): validate -> rate-limit -> admit credit ->
 * persist -> dispatch idempotently -> return chatId/messageId/runId/
 * realtime access. Supersedes S1's bare-MessageDTO response (S2
 * implementation plan §B Contradiction 3) — see
 * S1-chat-surface.md's acceptance checklist, marked NEEDS RE-VERIFICATION
 * for that criterion accordingly.
 */
export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  if (!(await getOwnedChat(auth.userId, chatId))) return notFound();

  const parsed = CreateMessageRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid message.", parsed.error.flatten());

  try {
    await checkAndIncrementRateLimit(auth.userId);
  } catch (error) {
    if (error instanceof RateLimitedError) return tooManyRequests(error.message);
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
    });
  } catch (error) {
    if (error instanceof ActiveRunExistsError) return conflict(error.message);
    if (error instanceof InsufficientCreditsError) return insufficientCredits();
    if (error instanceof AttachmentBindError) return badRequest(error.message);
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
    // The `trigger()` call itself failed (network/credential issue) — the
    // row is still `queued` with no confirmed triggerRunId. Finalize
    // immediately rather than leaving it for the reconciler's staleness
    // window; the client gets an honest failure, not a fake success.
    await finalizeFailed({
      runId: run.id,
      assistantMessageId: null,
      errorCode: "dispatch_failed",
      errorMessage: "Could not start the response. Please try again.",
      fromStatus: "queued",
    });
    return serverError("Could not start the response. Please try again.");
  }

  // Dispatch itself is confirmed successful past this point — a failure in
  // either follow-up step below must never be reported to the client as a
  // dispatch failure (that would tell the user to retry a turn that is
  // already running, risking a duplicate generation/charge). The run stays
  // `queued`/`running` and the lazy reconciler / a client-side run refetch
  // is the recovery path if these best-effort steps don't land.
  //
  // One bounded retry (mirrors the realtime-token retry just below) before
  // giving up — a transient DB blip here previously left `triggerRunId`
  // permanently unpersisted with no signal at all, which
  // reconcileIfStale's `!run.triggerRunId` branch would eventually treat
  // identically to "dispatch never confirmed" and fail-close a run that is
  // actually still executing server-side. Logging the final failure at
  // least makes that silent state loud rather than invisible.
  try {
    await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } });
  } catch {
    try {
      await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId } });
    } catch (error) {
      console.error(
        `[send-turn] failed to persist triggerRunId for run ${run.id} after dispatch succeeded (triggerRunId=${triggerRunId})`,
        error,
      );
    }
  }

  // One bounded retry before giving up — this is typically a transient
  // Clerk/Trigger.dev API blip, not a real outage (hardening pass: this
  // call previously wasn't even wrapped, so a failure here produced an
  // opaque unhandled-exception 500 indistinguishable from a genuine
  // dispatch failure).
  let accessToken: string;
  let expiresAt: Date;
  try {
    ({ accessToken, expiresAt } = await mintRealtimeToken(triggerRunId));
  } catch {
    try {
      ({ accessToken, expiresAt } = await mintRealtimeToken(triggerRunId));
    } catch {
      // The run is genuinely dispatched and running server-side — do not
      // touch/fail the AgentRun row. The client's existing reload-recovery
      // path (GET chat -> activeRunId -> GET /runs/:runId/realtime-token)
      // is the correct recovery mechanism, so this response must say so
      // explicitly rather than looking like a failed send.
      return realtimeUnavailable(
        "Your message was sent and a response is being generated, but the live connection could not be established. Reload to reconnect.",
      );
    }
  }

  return json(
    SendTurnResponseSchema.parse({
      chatId,
      message,
      run: toAgentRunDTO({ ...run, triggerRunId }),
      realtime: { runId: triggerRunId, streamKey: ASSISTANT_STREAM_KEY, accessToken, expiresAt: expiresAt.toISOString() },
    }),
    201,
  );
}

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { chatId } = await params;
  if (!(await getOwnedChat(auth.userId, chatId))) return notFound();

  const url = new URL(req.url);
  const parsed = ListMessagesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest("Invalid query parameters.", parsed.error.flatten());

  const page = await listMessages(chatId, parsed.data);
  return json(ListMessagesResponseSchema.parse(page));
}
