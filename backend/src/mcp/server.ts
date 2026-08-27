/**
 * S8 Phase 5 — the MCP tool surface. One `McpServer` instance per HTTP
 * request (per `createMcpHandler`'s stateless per-request factory model —
 * see src/app/api/mcp/route.ts), authenticated via `ctx.authInfo` set from
 * the route wrapper's `authenticateWithIdentity` result.
 *
 * Every tool is a thin wrapper over `src/services/*`/`src/mcp/actions.ts` —
 * never `src/trigger/turn.ts` directly (that would drag `sharp` and the
 * whole tool registry into this route's serverless bundle).
 */
import { z } from "zod";
import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createChat, listChats, getOwnedChat } from "@/services/chats";
import { getOwnedRun } from "@/services/runs";
import { getCreditSummary } from "@/services/credits";
import {
  respondToWaitpoint,
  WaitpointNotFoundError,
  WaitpointKindMismatchError,
} from "@/services/waitpoints";
// Hand-composed rather than `RespondToWaitpointRequestSchema.and(z.object({waitpointId}))`
// -- a Zod intersection of a discriminated union does not convert cleanly to
// the JSON Schema `tools/list` needs to advertise.
const RespondToWaitpointInputSchema = z.discriminatedUnion("kind", [
  z.object({ waitpointId: z.string().min(1), kind: z.literal("CREDIT_APPROVAL"), approved: z.boolean() }),
  z.object({ waitpointId: z.string().min(1), kind: z.literal("CLARIFICATION"), answer: z.string().min(1).max(2000) }),
]);
import { toAgentRunDTO } from "@/services/runs";
import { listToolInvocationDTOs } from "@/services/tool-invocations";
import { sendMessage, cancelRun, ActiveRunExistsError, InsufficientCreditsError, ChatNotFoundError, RateLimitedError } from "@/mcp/actions";
import { waitForRun, clampWaitSeconds } from "@/mcp/wait";
import { toolResultFromWait, errorResult } from "@/mcp/format";
import type { ContentBlock } from "@/contracts/common";

/** The Clerk-backed application `userId` a valid `AuthInfo.extra` carries — see the route wrapper. */
function appUserId(authInfo: AuthInfo | undefined): string {
  const userId = (authInfo?.extra as Record<string, unknown> | undefined)?.appUserId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("MCP request reached a tool handler without a resolved application user id.");
  }
  return userId;
}

export function buildVyomFlowServer(ctx: McpRequestContext) {
  const server = new McpServer({ name: "vyomflow", version: "1.0.0" });
  const userId = appUserId(ctx.authInfo);

  server.registerTool(
    "vyomflow_create_chat",
    {
      title: "Create chat",
      description: "Create a new VyomFlow chat, optionally with a title. Returns the new chat's id.",
      inputSchema: z.object({ title: z.string().trim().min(1).max(200).optional() }),
    },
    async ({ title }) => {
      const chat = await createChat(userId, title);
      return { content: [{ type: "text" as const, text: JSON.stringify(chat, null, 2) }] };
    },
  );

  server.registerTool(
    "vyomflow_list_chats",
    {
      title: "List chats",
      description: "List this caller's chats, most recently created first. Cursor-paginated.",
      inputSchema: z.object({
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async ({ cursor, limit }) => {
      const page = await listChats(userId, { cursor, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(page, null, 2) }] };
    },
  );

  server.registerTool(
    "vyomflow_send_message",
    {
      title: "Send message",
      description:
        "Send a message to a chat, dispatching a new agent turn, then wait up to waitSeconds (default 30, max 55) " +
        "for progress. A chat allows only ONE active run at a time — if a run is already in progress this returns " +
        "isError with { code: 'ACTIVE_RUN_EXISTS', runId }; call vyomflow_wait_for_run with that runId instead of retrying. " +
        "A typical turn (5-20s) completes within one call; for a longer turn, call vyomflow_wait_for_run again with the " +
        "returned cursor as fromIndex.",
      inputSchema: z.object({
        chatId: z.string().min(1),
        content: z.string().min(1),
        attachments: z.array(z.string()).optional(),
        model: z.string().optional(),
        waitSeconds: z.number().min(0).max(55).optional(),
      }),
    },
    async ({ chatId, content, attachments, model, waitSeconds }, toolCtx) => {
      const contentBlocks: ContentBlock[] = [{ type: "text", text: content }];
      try {
        const { run, triggerRunId } = await sendMessage({
          userId,
          chatId,
          content: contentBlocks,
          attachmentIds: attachments ?? [],
          model,
        });

        const outcome = await waitForRun({
          userId,
          runId: run.id,
          fromIndex: 0,
          waitSeconds: clampWaitSeconds(waitSeconds),
          triggerRunIdOverride: triggerRunId,
          signal: toolCtx.mcpReq.signal,
          notify: (progress, message) =>
            toolCtx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: toolCtx.mcpReq.id, progress, message } }),
        });
        if (!outcome) return errorResult({ code: "NOT_FOUND", message: "Run not found after dispatch." });

        return toolResultFromWait(outcome, { messageId: run.userMessageId });
      } catch (error) {
        if (error instanceof ChatNotFoundError) return errorResult({ code: "NOT_FOUND", message: error.message });
        if (error instanceof ActiveRunExistsError) {
          const chat = await getOwnedChat(userId, chatId);
          return errorResult({ code: "ACTIVE_RUN_EXISTS", runId: chat?.activeRunId ?? null, message: error.message });
        }
        if (error instanceof InsufficientCreditsError) return errorResult({ code: "INSUFFICIENT_CREDITS", message: error.message });
        if (error instanceof RateLimitedError) return errorResult({ code: "RATE_LIMITED", message: error.message });
        throw error;
      }
    },
  );

  server.registerTool(
    "vyomflow_wait_for_run",
    {
      title: "Wait for run",
      description:
        "Resume waiting on an in-progress run from fromIndex (the previous call's returned cursor, or 0). " +
        "Bounded to waitSeconds (default 30, max 55) -- call again with the new cursor if done is still false.",
      inputSchema: z.object({
        runId: z.string().min(1),
        fromIndex: z.number().int().nonnegative().optional(),
        waitSeconds: z.number().min(0).max(55).optional(),
      }),
    },
    async ({ runId, fromIndex, waitSeconds }, toolCtx) => {
      const outcome = await waitForRun({
        userId,
        runId,
        fromIndex: fromIndex ?? 0,
        waitSeconds: clampWaitSeconds(waitSeconds),
        signal: toolCtx.mcpReq.signal,
        notify: (progress, message) =>
          toolCtx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: toolCtx.mcpReq.id, progress, message } }),
      });
      if (!outcome) return errorResult({ code: "NOT_FOUND", message: "Run not found." });
      return toolResultFromWait(outcome);
    },
  );

  server.registerTool(
    "vyomflow_get_run",
    {
      title: "Get run",
      description: "Read a run's current durable state from the database. Never blocks.",
      inputSchema: z.object({ runId: z.string().min(1) }),
    },
    async ({ runId }) => {
      const run = await getOwnedRun(userId, runId);
      if (!run) return errorResult({ code: "NOT_FOUND", message: "Run not found." });
      const toolInvocations = await listToolInvocationDTOs(run.id);
      return { content: [{ type: "text" as const, text: JSON.stringify(toAgentRunDTO(run, toolInvocations), null, 2) }] };
    },
  );

  server.registerTool(
    "vyomflow_respond_waitpoint",
    {
      title: "Respond to waitpoint",
      description:
        "Answer a pending CREDIT_APPROVAL (approved: true|false) or CLARIFICATION (answer: string) waitpoint. " +
        "Idempotent -- responding to an already-resolved waitpoint returns its current state without error.",
      inputSchema: RespondToWaitpointInputSchema,
    },
    async (input) => {
      const { waitpointId, ...response } = input;
      try {
        const { waitpoint, alreadyResolved } = await respondToWaitpoint(waitpointId, userId, response);
        return { content: [{ type: "text" as const, text: JSON.stringify({ waitpoint, alreadyResolved }, null, 2) }] };
      } catch (error) {
        if (error instanceof WaitpointNotFoundError) return errorResult({ code: "NOT_FOUND", message: error.message });
        if (error instanceof WaitpointKindMismatchError) return errorResult({ code: "BAD_REQUEST", message: error.message });
        throw error;
      }
    },
  );

  server.registerTool(
    "vyomflow_cancel_run",
    {
      title: "Cancel run",
      description: "Request cancellation of an in-progress run. Idempotent -- a repeat call on an already-terminal run is a no-op.",
      inputSchema: z.object({ runId: z.string().min(1) }),
    },
    async ({ runId }) => {
      const dto = await cancelRun(userId, runId);
      if (!dto) return errorResult({ code: "NOT_FOUND", message: "Run not found." });
      return { content: [{ type: "text" as const, text: JSON.stringify(dto, null, 2) }] };
    },
  );

  server.registerTool(
    "vyomflow_get_credits",
    {
      title: "Get credits",
      description: "Read this caller's current credit balance, held amount, and available amount.",
      inputSchema: z.object({}),
    },
    async () => {
      const summary = await getCreditSummary(userId);
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    },
  );

  return server;
}
