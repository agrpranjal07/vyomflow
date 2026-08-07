/**
 * S8 — OpenAPI registry for the Mintlify docs surface (fallback/minimum scope,
 * S8-public-api-bonus.md). Reads existing `src/contracts/**` Zod schemas —
 * the same schemas the internal `/api/v1/**` Route Handlers already validate
 * against — and registers them for `zod-to-openapi`.
 *
 * Deliberately lives OUTSIDE `src/contracts/**`: adding a file there would
 * make `contracts:sync` copy it into the frontend and trip `contracts:check`
 * on drift, for a doc surface the frontend has no use for
 * (00-master-spec.md §2, S8 planning session file-collision analysis).
 *
 * The contract files below are read via an explicit allow-list (never a
 * glob) so a half-landed contract file from another in-flight slice can
 * never silently change what this generates.
 */
import "./zod-extend";

import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { ApiErrorSchema } from "@/contracts/common";
import {
  ChatDTOSchema,
  ChatIdParamSchema,
  CreateChatRequestSchema,
  ListChatsQuerySchema,
  ListChatsResponseSchema,
  UpdateChatRequestSchema,
} from "@/contracts/chats";
import {
  CreateMessageRequestSchema,
  ListMessagesQuerySchema,
  ListMessagesResponseSchema,
  MessageDTOSchema,
} from "@/contracts/messages";
import {
  AgentRunDTOSchema,
  AgentRunIdParamSchema,
  RealtimeAccessSchema,
  SendTurnResponseSchema,
} from "@/contracts/runs";
import { ToolInvocationDTOSchema } from "@/contracts/tools";
import {
  AttachmentDTOSchema,
  AttachmentIdParamSchema,
  CompleteAttachmentRequestSchema,
  ListAttachmentsQuerySchema,
  ListAttachmentsResponseSchema,
  RequestUploadParamsBatchRequestSchema,
  RequestUploadParamsResponseSchema,
} from "@/contracts/attachments";
import {
  RespondToWaitpointRequestSchema,
  WaitpointDTOSchema,
  WaitpointIdParamSchema,
} from "@/contracts/waitpoints";
import { z } from "zod";
import {
  CreditBalanceDTOSchema,
  CreditRunStepsDTOSchema,
  CreditUsageSummaryDTOSchema,
  ListCreditLedgerResponseSchema,
  ListCreditUsageEntriesResponseSchema,
} from "@/contracts/credits";

export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "ClerkBearer", {
    type: "http",
    scheme: "bearer",
    description:
      "Clerk session token, `Authorization: Bearer <token>`. This documents the app's own " +
      "internal auth as of S1-S6 — see S8-public-api-bonus.md for the fallback scope this " +
      "doc covers, and the public API-key scheme's own page once the full scope ships.",
  });

  const ErrorResponse = registry.register("ApiError", ApiErrorSchema);

  function errorResponse(description: string) {
    return {
      description,
      content: { "application/json": { schema: ErrorResponse } },
    };
  }

  const security = [{ ClerkBearer: [] }];

  // ---- Chats -------------------------------------------------------------
  const ChatDTO = registry.register("Chat", ChatDTOSchema);
  const ListChatsResponse = registry.register("ListChatsResponse", ListChatsResponseSchema);

  registry.registerPath({
    method: "post",
    path: "/api/v1/chats",
    tags: ["Chats"],
    summary: "Create a chat",
    security,
    request: {
      body: { content: { "application/json": { schema: CreateChatRequestSchema } } },
    },
    responses: {
      201: { description: "Chat created.", content: { "application/json": { schema: ChatDTO } } },
      401: errorResponse("Missing or invalid credentials."),
      400: errorResponse("Malformed request body."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/chats",
    tags: ["Chats"],
    summary: "List the caller's chats (cursor-paginated, newest first)",
    security,
    request: { query: ListChatsQuerySchema },
    responses: {
      200: {
        description: "Page of chats.",
        content: { "application/json": { schema: ListChatsResponse } },
      },
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/chats/{chatId}",
    tags: ["Chats"],
    summary: "Get a chat",
    security,
    request: { params: ChatIdParamSchema },
    responses: {
      200: { description: "The chat.", content: { "application/json": { schema: ChatDTO } } },
      404: errorResponse(
        "Not found — either the chat never existed or is not owned by the caller. " +
          "Identical response either way (00-master-spec.md §6, non-leaking 404).",
      ),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/v1/chats/{chatId}",
    tags: ["Chats"],
    summary: "Rename a chat",
    security,
    request: {
      params: ChatIdParamSchema,
      body: { content: { "application/json": { schema: UpdateChatRequestSchema } } },
    },
    responses: {
      200: { description: "Updated chat.", content: { "application/json": { schema: ChatDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/chats/{chatId}",
    tags: ["Chats"],
    summary: "Soft-delete a chat",
    security,
    request: { params: ChatIdParamSchema },
    responses: {
      204: { description: "Deleted (soft-delete; no body)." },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/chats/{chatId}/pin",
    tags: ["Chats"],
    summary: "Pin (favorite) a chat",
    security,
    request: { params: ChatIdParamSchema },
    responses: {
      200: { description: "Updated chat.", content: { "application/json": { schema: ChatDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/chats/{chatId}/pin",
    tags: ["Chats"],
    summary: "Unpin a chat",
    security,
    request: { params: ChatIdParamSchema },
    responses: {
      200: { description: "Updated chat.", content: { "application/json": { schema: ChatDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Messages / turn submission -----------------------------------------
  // Registered so the `ListMessagesResponse` page below refs it by name
  // instead of inlining it — not otherwise referenced directly.
  registry.register("Message", MessageDTOSchema);
  const ListMessagesResponse = registry.register("ListMessagesResponse", ListMessagesResponseSchema);
  const SendTurnResponse = registry.register("SendTurnResponse", SendTurnResponseSchema);

  registry.registerPath({
    method: "post",
    path: "/api/v1/chats/{chatId}/messages",
    tags: ["Messages"],
    summary: "Submit a message and start (or continue) an agent turn",
    description:
      "Reserves credit admission, persists the user message, and dispatches a durable " +
      "Trigger.dev turn. One active run per chat is enforced — a second send while a run " +
      "is active returns 409 CONFLICT. Idempotent per `send:{chatId}:{messageId}` " +
      "(00-master-spec.md §4).",
    security,
    request: {
      params: ChatIdParamSchema,
      body: { content: { "application/json": { schema: CreateMessageRequestSchema } } },
    },
    responses: {
      201: {
        description: "Message persisted and turn dispatched.",
        content: { "application/json": { schema: SendTurnResponse } },
      },
      402: errorResponse("Insufficient credits to start this turn."),
      409: errorResponse("A run is already active on this chat."),
      429: errorResponse("Application-level send-rate limit exceeded."),
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/chats/{chatId}/messages",
    tags: ["Messages"],
    summary: "List a chat's messages (cursor-paginated)",
    security,
    request: { params: ChatIdParamSchema, query: ListMessagesQuerySchema },
    responses: {
      200: {
        description: "Page of messages, oldest-to-newest within the page.",
        content: { "application/json": { schema: ListMessagesResponse } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Runs ----------------------------------------------------------------
  const AgentRunDTO = registry.register("AgentRun", AgentRunDTOSchema);
  const RealtimeAccess = registry.register("RealtimeAccess", RealtimeAccessSchema);

  registry.registerPath({
    method: "get",
    path: "/api/v1/runs/{runId}",
    tags: ["Runs"],
    summary: "Get a run's current status, including its tool invocations",
    security,
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: { description: "The run.", content: { "application/json": { schema: AgentRunDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/runs/{runId}/cancel",
    tags: ["Runs"],
    summary: "Cancel an active run",
    description:
      "Cascades cancellation to in-flight children; a media-processing task already in flight " +
      "cannot itself be cancelled remotely, so a background reconciliation sweep later " +
      "captures its true final cost (00-master-spec.md §4 scenario 7).",
    security,
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: { description: "Run cancelled.", content: { "application/json": { schema: AgentRunDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/runs/{runId}/realtime-token",
    tags: ["Runs"],
    summary: "Mint a fresh Trigger.dev realtime access token for this run",
    description:
      "Trigger.dev public access tokens default to a 15-minute expiry; this endpoint is the " +
      "mandatory refresh path for turns that run longer than that (00-master-spec.md §8).",
    security,
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: {
        description: "Fresh realtime access token.",
        content: { "application/json": { schema: RealtimeAccess } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Waitpoints ------------------------------------------------------------
  const WaitpointDTO = registry.register("Waitpoint", WaitpointDTOSchema);

  registry.registerPath({
    method: "post",
    path: "/api/v1/waitpoints/{waitpointId}/respond",
    tags: ["Waitpoints"],
    summary: "Respond to a pending CREDIT_APPROVAL or CLARIFICATION waitpoint",
    description:
      "Resumes the suspended run. A duplicate response to an already-`COMPLETED`/`EXPIRED` " +
      "waitpoint is a no-op guarded on `Waitpoint.status` (00-master-spec.md §4 scenario 9).",
    security,
    request: {
      params: WaitpointIdParamSchema,
      body: { content: { "application/json": { schema: RespondToWaitpointRequestSchema } } },
    },
    responses: {
      200: {
        description: "Waitpoint resolved.",
        content: { "application/json": { schema: WaitpointDTO } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Credits (S7) ------------------------------------------------------
  const CreditBalance = registry.register("CreditBalance", CreditBalanceDTOSchema);
  const ListCreditLedgerResponse = registry.register("ListCreditLedgerResponse", ListCreditLedgerResponseSchema);
  const CreditUsageSummary = registry.register("CreditUsageSummary", CreditUsageSummaryDTOSchema);
  const ListCreditUsageEntriesResponse = registry.register(
    "ListCreditUsageEntriesResponse",
    ListCreditUsageEntriesResponseSchema,
  );
  const CreditRunSteps = registry.register("CreditRunSteps", CreditRunStepsDTOSchema);
  const RunIdParam = z.object({ runId: z.string() });

  registry.registerPath({
    method: "get",
    path: "/api/v1/me/credits",
    tags: ["Credits"],
    summary: "Get the caller's credit balance",
    description: "available = balance - held, computed at read time — never a stored/cached value.",
    security,
    responses: {
      200: { description: "The caller's balance.", content: { "application/json": { schema: CreditBalance } } },
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/me/credits/ledger",
    tags: ["Credits"],
    summary: "List the caller's credit ledger, optionally filtered to one tool bucket",
    description:
      "Cursor-paginated, net-`CAPTURE`/`USAGE`-only rows (`RESERVE`/`RELEASE` are hold-lifecycle " +
      "bookkeeping, excluded here — see `/ledger/run/{runId}` for the full raw lifecycle).",
    security,
    responses: {
      200: {
        description: "A page of ledger entries.",
        content: { "application/json": { schema: ListCreditLedgerResponse } },
      },
      401: errorResponse("Missing or invalid credentials."),
      400: errorResponse("Invalid query parameters."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/me/credits/usage-summary",
    tags: ["Credits"],
    summary: "Get the caller's real per-tool credit usage aggregation",
    description:
      "A `GROUP BY toolInvocation.name` aggregation over `CreditLedger` CAPTURE/USAGE rows — " +
      "backs the /usage dashboard's stat cards and Overview tab.",
    security,
    responses: {
      200: {
        description: "Per-tool usage groups plus overall totals.",
        content: { "application/json": { schema: CreditUsageSummary } },
      },
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/me/credits/usage-entries",
    tags: ["Credits"],
    summary: "List the caller's netted usage entries for one tool bucket",
    description:
      "One row per run within the requested tool bucket (backs the /usage Detailed View tab's " +
      "record table) — `amount` is that run's CAPTURE/USAGE total, never RESERVE/RELEASE.",
    security,
    responses: {
      200: {
        description: "Netted usage entries for the requested tool.",
        content: { "application/json": { schema: ListCreditUsageEntriesResponse } },
      },
      401: errorResponse("Missing or invalid credentials."),
      400: errorResponse("Invalid query parameters (missing `tool`)."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/me/credits/ledger/run/{runId}",
    tags: ["Credits"],
    summary: "Get one run's full raw credit-ledger step breakdown",
    description:
      "Every `CreditLedger` row sharing this run's `runId` — the full RESERVE/CAPTURE/RELEASE/USAGE " +
      "lifecycle, not just the net-debited subset — backs the /usage \"Usage details\" modal. " +
      "Caller-scoped: a runId belonging to another user returns an empty `items`/`null` chatId, " +
      "never a 404/403 leak of whether that runId exists.",
    security,
    request: { params: RunIdParam },
    responses: {
      200: {
        description: "That run's full ledger step breakdown.",
        content: { "application/json": { schema: CreditRunSteps } },
      },
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Attachments -----------------------------------------------------------
  const AttachmentDTO = registry.register("Attachment", AttachmentDTOSchema);
  const ListAttachmentsResponse = registry.register(
    "ListAttachmentsResponse",
    ListAttachmentsResponseSchema,
  );
  const RequestUploadParamsResponse = registry.register(
    "RequestUploadParamsResponse",
    RequestUploadParamsResponseSchema,
  );

  registry.registerPath({
    method: "post",
    path: "/api/v1/attachments/upload-params",
    tags: ["Attachments"],
    summary: "Mint signed Transloadit assembly parameters for a resumable direct upload",
    security,
    request: {
      body: { content: { "application/json": { schema: RequestUploadParamsBatchRequestSchema } } },
    },
    responses: {
      200: {
        description: "Signed upload parameters, one set per requested file.",
        content: { "application/json": { schema: RequestUploadParamsResponse } },
      },
      400: errorResponse("File count/size/MIME type over the configured limits."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/attachments",
    tags: ["Attachments"],
    summary: "List the caller's media-library attachments (cursor-paginated)",
    security,
    request: { query: ListAttachmentsQuerySchema },
    responses: {
      200: {
        description: "Page of attachments.",
        content: { "application/json": { schema: ListAttachmentsResponse } },
      },
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/attachments/{attachmentId}/complete",
    tags: ["Attachments"],
    summary: "Mark a direct upload complete once the Transloadit assembly finishes",
    security,
    request: {
      params: AttachmentIdParamSchema,
      body: { content: { "application/json": { schema: CompleteAttachmentRequestSchema } } },
    },
    responses: {
      200: {
        description: "Finalized attachment.",
        content: { "application/json": { schema: AttachmentDTO } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/attachments/{attachmentId}",
    tags: ["Attachments"],
    summary: "Permanently delete a media-library attachment",
    security,
    request: { params: AttachmentIdParamSchema },
    responses: {
      204: { description: "Deleted." },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // Registered for completeness/cross-linking even though not directly
  // exposed as a standalone path — ToolInvocation is embedded in AgentRun.
  registry.register("ToolInvocation", ToolInvocationDTOSchema);

  return registry;
}

/**
 * Single generation entry point — used by both `scripts/generate-openapi.ts`
 * (writes `docs/openapi.json`) and `test/unit/openapi-generation.test.ts`
 * (asserts correctness), so the test exercises the exact document that
 * ships, not a re-derived copy.
 */
export function generateOpenApiDocument() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "VyomFlow API",
      version: "1.0.0",
      description:
        "Internal REST surface (S1–S6) exposed as reference documentation. This is the S8 " +
        "minimum-fallback scope (Submission Requirement #13) — generated directly from the " +
        "same Zod contracts the Route Handlers validate against, not a hand-maintained " +
        "duplicate. Auth documented here is the app's own Clerk bearer scheme; see the " +
        "public API-key section for the versioned public surface, where shipped.",
    },
    servers: [{ url: "{baseUrl}", variables: { baseUrl: { default: "http://localhost:3000" } } }],
  });
}
