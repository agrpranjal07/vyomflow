/**
 * S8 Phase 4 — `GET /api/public/v1/runs/{runId}/stream`, the primary public
 * live-transport for a turn (.claude/rules/realtime-transport-policy.md:
 * SSE/Trigger Realtime is the default, polling is never the primary
 * channel). We subscribe to Trigger.dev Realtime server-side and re-emit
 * our own vendor-neutral event schema (src/contracts/public-events.ts) —
 * never the raw Trigger token: it exposes internal identifiers
 * (userId/chatId/userMessageId) and its 15-minute expiry is short against
 * a 450s+waitpoint worst-case turn (see the plan's Phase 4 rationale).
 *
 * Runtime must be nodejs (Prisma + @prisma/adapter-pg) — Edge cannot run
 * this. maxDuration=300 is the Vercel Fluid-compute ceiling; we close
 * ourselves at 285s (SSE_GRACEFUL_CLOSE_MS) well before Vercel would cut
 * the connection mid-frame.
 */
import { runs as triggerRuns, streams } from "@trigger.dev/sdk";
import { authenticateWithIdentity, requireScopes } from "@/lib/auth";
import { publicCorsHeaders, publicHandleOptions, notFound } from "@/lib/http";
import { prisma } from "@/lib/db";
import { getOwnedRun, reconcileIfStale, toAgentRunDTO } from "@/services/runs";
import { listToolInvocationDTOs, toToolInvocationDTO } from "@/services/tool-invocations";
import { ASSISTANT_STREAM_KEY } from "@/trigger/streams";
import type { TurnStreamPart, ToolStreamPart } from "@/contracts/runs";
import type { ToolInvocationDTO } from "@/contracts/tools";
import type { AgentRun } from "@/generated/prisma/client";
import type {
  PublicRunStatusEvent,
  PublicMessageDeltaEvent,
  PublicToolStatusEvent,
  PublicWaitpointEvent,
  PublicRunTerminalEvent,
  PublicStreamResetEvent,
} from "@/contracts/public-events";

export const runtime = "nodejs";
export const maxDuration = 300;

const SSE_HEARTBEAT_MS = 15_000;
const SSE_GRACEFUL_CLOSE_MS = 285_000; // maxDuration - 15s

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function OPTIONS() {
  return publicHandleOptions();
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authenticateWithIdentity(req, undefined, "public");
  if (auth instanceof Response) return auth;
  const scopeError = requireScopes(auth.identity, "runs:read");
  if (scopeError) return scopeError;

  const { runId } = await params;
  const run = await getOwnedRun(auth.userId, runId);
  if (!run) return notFound("public");

  const reconciled = await reconcileIfStale(run);

  // Never accept `?access_token=` — the Authorization header is the only
  // credential location this route (or any other) accepts. `fromIndex` is
  // an unauthenticated resume position, not a credential, so it's fine in
  // the query string.
  const url = new URL(req.url);
  const lastEventId = req.headers.get("Last-Event-ID");
  const parsedLastEventId = lastEventId !== null ? Number(lastEventId) : NaN;
  const startIndex = Number.isFinite(parsedLastEventId)
    ? parsedLastEventId + 1
    : Number(url.searchParams.get("fromIndex") ?? 0) || 0;

  const body = buildSseStream(reconciled, startIndex);

  return new Response(body, {
    status: 200,
    headers: {
      ...publicCorsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function buildSseStream(run: AgentRun, startIndex: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const toolCache = new Map<string, ToolInvocationDTO>();
  let closed = false;
  let lastIndexSent = startIndex - 1;
  // Declared here (not as `const` at their point of use inside `start()`)
  // so `cleanup()` — reachable from the terminal-before-connect early
  // return, before either timer exists yet — can safely no-op on
  // `undefined` instead of a temporal-dead-zone ReferenceError.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Enqueued before any await so the first byte leaves the handler
      // synchronously — NOTE (uncertain, flagged in the report): whether a
      // Next 16 Route Handler `Response` backed by a `ReadableStream`
      // actually flushes this incrementally rather than buffering until
      // the stream ends could not be verified without a live deployment;
      // treat as unconfirmed until checked against a real Vercel response.
      controller.enqueue(encoder.encode(": connected\n\nretry: 1000\n\n"));

      function send(event: string, data: unknown, index?: number) {
        if (closed) return;
        let frame = "";
        if (index !== undefined) {
          frame += `id: ${index}\n`;
          lastIndexSent = index;
        }
        frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Controller already closed by the client disconnecting — cleanup() below handles it.
        }
      }

      function sendSnapshot(r: AgentRun) {
        const snapshot: PublicRunStatusEvent = {
          runId: r.id,
          status: r.status,
          lastStreamIndex: r.lastStreamIndex,
          cancelRequestedAt: r.cancelRequestedAt?.toISOString() ?? null,
        };
        // Reconciliation cursor only — not a resume-point id (see contract comment).
        send("run.status", snapshot, r.lastStreamIndex);
      }

      async function sendTerminalAndClose(r: AgentRun) {
        const toolInvocations = await listToolInvocationDTOs(r.id);
        const dto = toAgentRunDTO(r, toolInvocations);
        const eventName =
          r.status === "completed" ? "run.completed" : r.status === "failed" ? "run.failed" : "run.cancelled";
        const payload: PublicRunTerminalEvent = {
          runId: r.id,
          status: r.status,
          assistantMessageId: r.assistantMessageId,
          totalCreditsUsed: dto.totalCreditsUsed,
          errorCode: r.errorCode,
          errorMessage: r.errorMessage,
        };
        send(eventName, payload, r.lastStreamIndex);
        cleanup();
      }

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        clearTimeout(graceTimer);
        abortController.abort();
        try {
          controller.close();
        } catch {
          // Already closed by the client — fine.
        }
      }

      sendSnapshot(run);

      // Terminal-before-connect: never call streams.read/subscribeToRun on
      // a finished run — Trigger.dev has nothing left to emit and the read
      // would hang against its own read timeout instead of returning.
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        await sendTerminalAndClose(run);
        return;
      }

      if (!run.triggerRunId) {
        // Dispatch was never confirmed for a non-terminal run — the same
        // "dispatch_unconfirmed" edge reconcileIfStale guards against, but
        // this connection can't wait out that staleness window. Report the
        // current (queued) status and end the connection; the client's own
        // reconnect/backoff will pick it up once reconcileIfStale settles it.
        cleanup();
        return;
      }

      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, SSE_HEARTBEAT_MS);

      graceTimer = setTimeout(() => {
        const reset: PublicStreamResetEvent = { reason: "duration_limit", nextFromIndex: lastIndexSent + 1 };
        // `id:` on every data event per the framing rule — reusing the
        // current cursor here (not advancing it) since `nextFromIndex` in
        // the payload is already the resume pointer a client needs.
        send("stream.reset", reset, lastIndexSent);
        try {
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
        } catch {
          // ignore — cleanup below still runs
        }
        cleanup();
      }, SSE_GRACEFUL_CLOSE_MS);

      async function enrichTool(part: ToolStreamPart): Promise<PublicToolStatusEvent> {
        let cached = toolCache.get(part.toolInvocationId);
        if (!cached) {
          // One query per distinct tool per connection, not per event.
          const row = await prisma.toolInvocation.findUnique({ where: { id: part.toolInvocationId } });
          if (row) {
            cached = toToolInvocationDTO(row);
            toolCache.set(part.toolInvocationId, cached);
          }
        }
        return {
          index: part.index,
          toolInvocationId: part.toolInvocationId,
          toolCallId: cached?.toolCallId ?? part.toolInvocationId,
          name: part.name,
          turnIndex: cached?.turnIndex ?? 0,
          callIndex: cached?.callIndex ?? 0,
          status: part.status,
          creditUsed: part.creditUsed,
          resultUrls: part.resultUrls,
          errorMessage: part.errorMessage,
          errorCode: part.errorCode,
        };
      }

      async function handlePart(part: TurnStreamPart) {
        if (part.type === "text") {
          const evt: PublicMessageDeltaEvent = { index: part.index, channel: part.channel, delta: part.delta };
          send("message.delta", evt, part.index);
        } else if (part.type === "tool") {
          const evt = await enrichTool(part);
          send("tool.status", evt, part.index);
        } else {
          const evt: PublicWaitpointEvent = { index: part.index, waitpoint: part.waitpoint };
          const eventName = part.waitpoint.status === "PENDING" ? "waitpoint.created" : "waitpoint.resolved";
          send(eventName, evt, part.index);
        }
      }

      async function finalizeFromDb() {
        const fresh = await prisma.agentRun.findUnique({ where: { id: run.id } });
        if (!fresh) {
          cleanup();
          return;
        }
        const reconciledFresh = await reconcileIfStale(fresh);
        await sendTerminalAndClose(reconciledFresh);
      }

      const partStream = await streams.read<TurnStreamPart>(run.triggerRunId, ASSISTANT_STREAM_KEY, {
        startIndex,
        signal: abortController.signal,
      });
      // `stopOnCompletion` defaults to true in this SDK version (verified in
      // sdk/runs.d.ts — the plan's `closeOnComplete` name does not exist
      // here), which is exactly the behavior we want: the subscription ends
      // itself once Trigger.dev reports the run terminal.
      const runSubscription = triggerRuns.subscribeToRun(run.triggerRunId, {
        signal: abortController.signal,
      });

      const partReader = partStream.getReader();
      const runReader = runSubscription.getReader();

      async function pumpParts() {
        try {
          while (!closed) {
            const { value, done } = await partReader.read();
            if (done) return;
            await handlePart(value);
          }
        } catch {
          // Aborted (cleanup already ran) or a transient read error — the
          // client's own reconnect-with-Last-Event-ID is the recovery path.
        }
      }

      async function pumpRunStatus() {
        try {
          while (!closed) {
            const { value, done } = await runReader.read();
            if (done) return;
            if (value.isCompleted || value.isFailed || value.isCancelled) {
              await finalizeFromDb();
              return;
            }
          }
        } catch {
          // Same degrade-to-reconnect story as pumpParts.
        }
      }

      // Promise.all, not Promise.race: the run-status subscription can end
      // (`done: true`) for reasons unrelated to the run actually finishing
      // (e.g. its own SSE connection cycling) — racing would let that
      // prematurely close a connection that still has text/tool parts left
      // to deliver. Only an explicit terminal detection above calls
      // `finalizeFromDb` (which closes via `sendTerminalAndClose`); once
      // that runs, `abortController.abort()` unblocks whichever pump is
      // still waiting, so this still resolves promptly. The `cleanup()`
      // after is a defensive no-op (guarded by `closed`) for the case where
      // both pumps end naturally without either ever calling it.
      await Promise.all([pumpParts(), pumpRunStatus()]);
      cleanup();
    },
    cancel() {
      // Client disconnected — stop both Trigger.dev subscriptions immediately.
      abortController.abort();
    },
  });
}
