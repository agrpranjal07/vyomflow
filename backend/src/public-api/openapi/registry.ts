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
  ListCreditLedgerQuerySchema,
  ListCreditLedgerResponseSchema,
  ListCreditUsageEntriesQuerySchema,
  ListCreditUsageEntriesResponseSchema,
} from "@/contracts/credits";
import { SetWebhookEndpointRequestSchema, WebhookEndpointDTOSchema } from "@/contracts/webhooks";
import { PublicSendTurnResponseSchema } from "@/public-api/mappers";
import { CreateApiKeyRequestSchema } from "@/services/api-keys";

export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "ClerkBearer", {
    type: "http",
    scheme: "bearer",
    description:
      "Clerk session token, `Authorization: Bearer <token>` — the first-party browser app's " +
      "own auth. Used only by this internal `/api/v1/*` surface, never by `/api/public/v1/*`.",
  });

  registry.registerComponent("securitySchemes", "ApiKeyAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "Clerk-native API key, `Authorization: Bearer <key>`. Minted at " +
      "https://www.vyomflow.co.in/settings/api-keys, scoped per operation. 401 = missing/" +
      "invalid/revoked key; 403 = valid key missing the required scope.",
  });

  const ErrorResponse = registry.register("ApiError", ApiErrorSchema);

  function errorResponse(description: string) {
    return {
      description,
      content: { "application/json": { schema: ErrorResponse } },
    };
  }

  function apiKeyErrorResponses(scope: string) {
    return {
      401: errorResponse("Missing, invalid, or revoked API key."),
      403: errorResponse(`Valid key missing the required \`${scope}\` scope.`),
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
      500: errorResponse("The Trigger.dev dispatch call itself failed; the turn was not started."),
      503: errorResponse(
        "The turn was dispatched and is genuinely running, but minting a fresh realtime " +
          "access token failed after dispatch succeeded — reload to reconnect, do not resend.",
      ),
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
      400: errorResponse("Response kind doesn't match this waitpoint's kind, or malformed body."),
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
    request: { query: ListCreditLedgerQuerySchema },
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
    request: { query: ListCreditUsageEntriesQuerySchema },
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
      201: {
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
    summary: "Cancel a mid-upload attachment, or permanently delete an unbound one",
    description:
      "Cancels a PENDING upload, or permanently deletes a READY/FAILED/CANCELLED unbound row " +
      "otherwise — never a row already bound to a sent message. Returns the resulting " +
      "attachment, not an empty body.",
    security,
    request: { params: AttachmentIdParamSchema },
    responses: {
      200: {
        description: "The cancelled or deleted attachment.",
        content: { "application/json": { schema: AttachmentDTO } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // Registered for completeness/cross-linking even though not directly
  // exposed as a standalone path — ToolInvocation is embedded in AgentRun.
  registry.register("ToolInvocation", ToolInvocationDTOSchema);

  // ---- Webhooks (S8 Phase 6) -------------------------------------------
  // Session-token auth on the internal `/api/v1` surface — this is an
  // account setting a signed-in browser user configures, not agent-facing,
  // so it is not under `/api/public/v1`.
  const WebhookEndpointDTO = registry.register("WebhookEndpoint", WebhookEndpointDTOSchema);

  registry.registerPath({
    method: "post",
    path: "/api/v1/webhooks",
    tags: ["Webhooks"],
    summary: "Set (or rotate) the caller's outbound webhook endpoint",
    description:
      "One `WebhookEndpoint` row per user. First call creates it and returns a server-generated " +
      "`secret` in plaintext (the only time it is ever shown again). A later call without " +
      "`rotateSecret` just updates `url`; `rotateSecret: true` moves the current secret into " +
      "`secondarySecret` (kept valid for a grace window) and mints a fresh `secret`. Deliveries " +
      "carry `X-Vyomflow-Signature: sha384=<hex(HMAC_SHA384(`${timestamp}.${rawBody}`, secret))>`, " +
      "`X-Vyomflow-Timestamp`, `X-Vyomflow-Event-Id`, and `X-Vyomflow-Delivery-Attempt` for " +
      "`agent.started`/`agent.completed`/`agent.failed`/`tool.completed` events.",
    security,
    request: {
      body: { content: { "application/json": { schema: SetWebhookEndpointRequestSchema } } },
    },
    responses: {
      200: {
        description: "The endpoint's current state, including the secret(s) if just (re)generated.",
        content: { "application/json": { schema: WebhookEndpointDTO } },
      },
      400: errorResponse("Malformed request body."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- API keys (self-serve minting, S8 Phase 3 follow-up) --------------
  // Session-token auth on the internal `/api/v1` surface — same rationale as
  // `/api/v1/webhooks` above. Mints a key via Clerk's Backend API, scoped to
  // `PUBLIC_API_DEFAULT_SCOPES` (Clerk's own Frontend-API `<APIKeys/>` widget
  // can never attach scopes — see src/services/api-keys.ts).
  const ApiKeyResponseSchema = registry.register(
    "ApiKeyResponse",
    z.object({
      id: z.string(),
      name: z.string(),
      secret: z.string().describe("The raw key value. Shown exactly once, on creation."),
      scopes: z.array(z.string()),
      expiresAt: z.string().nullable(),
    }),
  );

  registry.registerPath({
    method: "post",
    path: "/api/v1/api-keys",
    tags: ["API Keys"],
    summary: "Mint a self-serve public-API key",
    description:
      "Creates a new API key for the caller, scoped to the fixed default set of public-API " +
      "scopes. The `secret` is returned in plaintext only on this response and cannot be " +
      "retrieved again afterward.",
    security,
    request: {
      body: { content: { "application/json": { schema: CreateApiKeyRequestSchema } } },
    },
    responses: {
      201: {
        description: "The newly created key, including its plaintext secret.",
        content: { "application/json": { schema: ApiKeyResponseSchema } },
      },
      400: errorResponse("Malformed request body."),
      401: errorResponse("Missing or invalid credentials."),
    },
  });

  // ---- Public API (S8 Phase 3/4) ----------------------------------------
  // Bearer API-key auth, per-path required scope, public CORS (`*`). Same
  // underlying `src/services/**` as the internal `/api/v1/*` routes above —
  // these are documented separately because auth, security requirements,
  // and (for send-turn) response shape differ.
  const PublicSendTurnResponse = registry.register(
    "PublicSendTurnResponse",
    PublicSendTurnResponseSchema,
  );

  registry.registerPath({
    method: "post",
    path: "/api/public/v1/chats",
    tags: ["Public API"],
    summary: "Create a chat",
    security: [{ ApiKeyAuth: ["chats:write"] }],
    request: {
      body: { content: { "application/json": { schema: CreateChatRequestSchema } } },
    },
    responses: {
      201: { description: "Chat created.", content: { "application/json": { schema: ChatDTO } } },
      400: errorResponse("Malformed request body."),
      ...apiKeyErrorResponses("chats:write"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/public/v1/chats",
    tags: ["Public API"],
    summary: "List the caller's chats (cursor-paginated, newest first)",
    security: [{ ApiKeyAuth: ["chats:read"] }],
    request: { query: ListChatsQuerySchema },
    responses: {
      200: {
        description: "Page of chats.",
        content: { "application/json": { schema: ListChatsResponse } },
      },
      ...apiKeyErrorResponses("chats:read"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/public/v1/chats/{chatId}/messages",
    tags: ["Public API"],
    summary: "Submit a message and start (or continue) an agent turn",
    description:
      "Same Turn Lifecycle as the internal route, plus an optional `Idempotency-Key` header — a " +
      "retried request presenting the same key for this chat replays the original turn's " +
      "current state rather than charging credits or dispatching twice. Response omits the raw " +
      "Trigger.dev realtime token; `stream.url` points at this API's own SSE endpoint instead.",
    security: [{ ApiKeyAuth: ["runs:write"] }],
    request: {
      params: ChatIdParamSchema,
      headers: z.object({ "Idempotency-Key": z.string().optional() }),
      body: { content: { "application/json": { schema: CreateMessageRequestSchema } } },
    },
    responses: {
      201: {
        description: "Message persisted and turn dispatched (or the replayed prior result).",
        content: { "application/json": { schema: PublicSendTurnResponse } },
      },
      400: errorResponse("Malformed request body."),
      402: errorResponse("Insufficient credits to start this turn."),
      404: errorResponse("Not found (non-leaking — see above)."),
      409: errorResponse("A run is already active on this chat."),
      429: errorResponse("Per-API-key rate limit exceeded (`X-RateLimit-*`/`Retry-After` headers set)."),
      500: errorResponse("The Trigger.dev dispatch call itself failed; the turn was not started."),
      ...apiKeyErrorResponses("runs:write"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/public/v1/chats/{chatId}/messages",
    tags: ["Public API"],
    summary: "List a chat's messages (cursor-paginated)",
    security: [{ ApiKeyAuth: ["chats:read"] }],
    request: { params: ChatIdParamSchema, query: ListMessagesQuerySchema },
    responses: {
      200: {
        description: "Page of messages, oldest-to-newest within the page.",
        content: { "application/json": { schema: ListMessagesResponse } },
      },
      404: errorResponse("Not found (non-leaking — see above)."),
      ...apiKeyErrorResponses("chats:read"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/public/v1/runs/{runId}",
    tags: ["Public API"],
    summary: "Get a run's current status, including its tool invocations",
    security: [{ ApiKeyAuth: ["runs:read"] }],
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: { description: "The run.", content: { "application/json": { schema: AgentRunDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      ...apiKeyErrorResponses("runs:read"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/public/v1/runs/{runId}/stream",
    tags: ["Public API"],
    summary: "Subscribe to a run's live event stream (SSE)",
    description:
      "text/event-stream, not JSON — the individual event shapes are Zod-defined in " +
      "src/contracts/public-events.ts and documented in full on the streaming guide, since SSE " +
      "cannot be expressed as an OpenAPI response schema. Resume with the standard `Last-Event-ID` " +
      "header; never pass the API key as a query parameter.",
    security: [{ ApiKeyAuth: ["runs:read"] }],
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: { description: "An open `text/event-stream` connection." },
      404: errorResponse("Not found (non-leaking — see above)."),
      ...apiKeyErrorResponses("runs:read"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/public/v1/runs/{runId}/cancel",
    tags: ["Public API"],
    summary: "Cancel an active run",
    security: [{ ApiKeyAuth: ["runs:write"] }],
    request: { params: AgentRunIdParamSchema },
    responses: {
      200: { description: "Run cancelled.", content: { "application/json": { schema: AgentRunDTO } } },
      404: errorResponse("Not found (non-leaking — see above)."),
      ...apiKeyErrorResponses("runs:write"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/public/v1/waitpoints/{waitpointId}/respond",
    tags: ["Public API"],
    summary: "Respond to a pending CREDIT_APPROVAL or CLARIFICATION waitpoint",
    description:
      "Idempotent — a repeat call on an already-resolved waitpoint still returns 200 with the " +
      "current DTO, never an error.",
    security: [{ ApiKeyAuth: ["waitpoints:respond"] }],
    request: {
      params: WaitpointIdParamSchema,
      body: { content: { "application/json": { schema: RespondToWaitpointRequestSchema } } },
    },
    responses: {
      200: {
        description: "Waitpoint resolved.",
        content: { "application/json": { schema: WaitpointDTO } },
      },
      400: errorResponse("Response kind doesn't match this waitpoint's kind, or malformed body."),
      404: errorResponse("Not found (non-leaking — see above)."),
      ...apiKeyErrorResponses("waitpoints:respond"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/public/v1/me/credits",
    tags: ["Public API"],
    summary: "Get the caller's credit balance",
    description: "available = balance - held, computed at read time — never a stored/cached value.",
    security: [{ ApiKeyAuth: ["credits:read"] }],
    responses: {
      200: { description: "The caller's balance.", content: { "application/json": { schema: CreditBalance } } },
      ...apiKeyErrorResponses("credits:read"),
    },
  });

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
        "The versioned public REST surface (`/api/public/v1/*`, bearer API-key auth) plus the " +
        "app's own internal `/api/v1/*` surface (Clerk session-token auth), generated directly " +
        "from the same Zod contracts the Route Handlers validate against — never a " +
        "hand-maintained duplicate. The MCP endpoint (`/api/mcp`) is a separate streamable-HTTP " +
        "JSON-RPC transport, not expressible here — see the MCP guide.",
    },
    servers: [
      { url: "https://api.vyomflow.co.in", description: "Production" },
      { url: "http://localhost:3000", description: "Local development" },
    ],
  });
}
