# VyomFlow Backend

The backend/API for VyomFlow: an agent workspace that runs tools, streams work, and keeps the ledger. Durable multi-turn agent runs, typed tool execution, an on-demand skills system, credit accounting, and realtime delivery, backed by PostgreSQL as the single source of truth.

This app's Next.js Route Handlers **are** the REST API — there is no separate API service.

## Stack

Next.js (App Router, Route Handlers), TypeScript (strict), pnpm · PostgreSQL + Prisma ·
Clerk (auth) · OpenRouter Free (`openrouter/free`) with a hand-rolled, provider-neutral
tool-calling loop · Trigger.dev + Realtime (durable execution, streaming, waitpoints) ·
Transloadit (signed upload assemblies) · Cloudflare Workers AI (image generation) · Zod (contracts at every trust boundary).

## Prerequisites

- Node.js 20+
- pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- PostgreSQL (a `docker-compose.yml` is included for local dev/test databases)
- A Trigger.dev project (free tier) for durable task execution
- Clerk, OpenRouter, and Transloadit accounts (all have free tiers usable for this project)
- A Cloudflare account with Workers AI access (free daily allowance) — required for image generation

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in real values, see below
docker compose up -d         # local Postgres for dev + a separate test database
pnpm prisma:migrate          # apply migrations to the dev database
pnpm dev                     # start the API on http://localhost:3000
```

In a second terminal, start the Trigger.dev dev worker so agent turns and tool dispatches
actually run:

```bash
npx trigger.dev@latest dev
```

### Environment variables

See `.env.example` for the full list with inline notes. In short:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` / `SHADOW_DATABASE_URL` | Dev, integration-test, and Prisma migration-diff databases — always three separate databases |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` | Auth — this app verifies bearer tokens independently of the frontend's own Clerk middleware |
| `FRONTEND_ORIGIN` | CORS allowlist for the deployed/dev frontend origin |
| `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL`) | The core LLM path — always routed through the free router, no paid fallback |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Image generation via Cloudflare Workers AI (token needs `Workers AI: Edit` scope) |
| `TRIGGER_SECRET_KEY` / `TRIGGER_PROJECT_REF` | Durable task execution and realtime streaming |
| `TRANSLOADIT_AUTH_KEY` / `TRANSLOADIT_AUTH_SECRET` | Signed upload assemblies, generated server-side only |
| `PUBLIC_API_BASE_URL` | This API's own public base URL — OpenAPI `servers`, public-surface links. Required in production (module load throws if unset) |

Values differ by environment (local / Vercel Preview / Vercel Production) — see the inline
comments in `.env.example` for the expected value in each. Never put a real secret in
`.env.example`; only names, purpose, and non-secret examples belong there. Webhook delivery has
no environment variable of its own — signing secrets are generated per-endpoint server-side and
returned once when a user registers or rotates their endpoint.

## Scripts

```bash
pnpm dev              # start dev server
pnpm build            # production build
pnpm start            # run production build
pnpm lint             # lint
pnpm prisma:migrate   # apply Prisma migrations (dev)
pnpm prisma:deploy    # apply Prisma migrations (production, non-interactive)
pnpm contracts:sync   # copy src/contracts/** into the frontend repo, with a checksum lockfile
pnpm docs:openapi     # generate the OpenAPI document from src/contracts/** for the Mintlify docs
```

## Architecture overview

**Turn lifecycle.** An authenticated `POST` to a chat's messages endpoint validates auth,
ownership, message size, attachments, and model selection; applies rate limiting; reserves the
minimum refundable credit admission; persists the user message; and dispatches one durable
Trigger.dev task, returning immediately with `chatId`, `messageId`, `runId`, and a realtime access
token. The task itself restores conversation context, runs the OpenRouter agent loop, streams text
and thinking deltas token-by-token, dispatches typed tool calls (loading skills on demand and
calling image generation, cropping, and video-merge tools as needed), and finalizes to a terminal,
explainable state — never leaving a run silently stuck.

**State placement.** PostgreSQL is the durable source of truth for everything: chats, messages
(ordered, typed content blocks), agent runs, tool invocations, loaded skills, waitpoints,
attachments, and the full credit ledger. Trigger.dev owns execution mechanics only — task
boundaries, retries, idempotency windows, and cancellation propagation — and every fact it holds
is reconstructable from Postgres; it is never queried as a second source of truth. Realtime
(Trigger.dev Realtime, a `streams.define()`-typed text stream plus run metadata) is transport
only — the frontend can always fall back to a plain REST read if the realtime connection is
unavailable.

**Contracts.** Every request, response, tool input/output, and realtime-metadata shape has a pure
Zod schema in `src/contracts/**`, importing nothing but `zod`. The frontend consumes a
checksum-pinned, generated copy of the same schemas and runtime-validates every response against
them (`Schema.parse`), not a type assertion — the contract is enforced at runtime on both sides of
the network boundary, not just at compile time.

**Tools and skills.** A single tool registry (`src/server/tools/registry.ts`) is the one
authoritative source for tool discovery, input/output validation, credit estimation, and dispatch;
adding a tool means adding one registry entry, not touching orchestration branches. Skills
(`agent-skills/<name>/SKILL.md`) are versioned, on-demand guidance — the base prompt only ever
sees skill names and descriptions, and the model must explicitly call a typed `load_skill` tool to
pull in the full guidance for a turn. Loaded skills and their content hash are recorded against the
run so a retry or resume reuses the same guidance rather than re-resolving content that may have
changed on disk.

**Credits.** A refundable `CreditHold` is reserved at send time and grown incrementally before
each tool dispatch (an atomic, row-locked conditional update — never a read-then-write, closing the
classic TOCTOU race under concurrent sends). Every reservation, capture, and release is also
recorded as an immutable `CreditLedger` row under a unique idempotency key, so the ledger is the
audit source of truth and the denormalized hold/balance fields are just an O(1) admission-check
cache over it. Independent tool calls within a turn dispatch concurrently once each one's
reservation has already succeeded serially (in model-emitted order) — this keeps mid-turn credit
exhaustion, charge settlement, and persisted message ordering fully deterministic regardless of
which network call actually finishes first.

**Reliability.** One active run per chat is enforced at the database level (a partial unique
index), not just in application logic. Every external dispatch is guarded by
idempotency keys plus a `DISPATCHING`-before-POST row write, so a retried worker can tell "never
sent" from "sent, outcome unknown" and never blindly re-fires a paid call. A periodic
reconciliation sweep catches any run or tool invocation stuck in a non-terminal state past a
threshold. Structured logs on every code path in the turn lifecycle carry `chatId`, `runId`,
`messageId`, and a trace ID, so a failed turn is explainable from logs alone.

## Design decisions and trade-offs

- **Shared Zod over generated OpenAPI types for the internal contract.** Zod schemas are the
  single source of truth and are synced into the frontend as committed, checksum-verified files
  (`pnpm contracts:sync` / the frontend's `contracts:check` build step) rather than fetched live or
  published to a private registry. This gives real runtime validation at the boundary (not just
  compile-time types) and avoids a first-deploy bootstrap problem, at the cost of a committed
  generated copy that must be re-synced by hand when contracts change — it cannot drift silently
  (the build fails if it does), but it is not a live fetch either.
- **Independent tool calls parallelized, admission kept sequential.** Rather than either fully
  sequential dispatch (simpler, but wastes wall-clock time when a turn calls multiple independent
  tools) or naive full parallelism (which would make credit admission and message ordering
  depend on network race timing), only the slow network round trip is parallelized; everything
  that determines *which* calls get admitted when credit runs low stays strictly ordered.
- **OpenRouter Free budget is a real, shared constraint.** With no purchased credits the free
  router is rate-limited (20 requests/minute, 50/day), so automated tests exercise failure paths
  (429, empty stream, malformed tool calls) against deterministic fixtures, and real calls are
  reserved for the primary success-path acceptance runs and the demo.

## Surfaces

- **`https://www.vyomflow.co.in`** — first-party browser app (frontend), Clerk session-cookie auth.
- **`https://api.vyomflow.co.in`** — this app. The internal API (`/api/v1/*`, session-token only,
  used by the frontend), a public REST API (`/api/public/v1/*`, bearer API-key only), and an MCP
  server (`/api/mcp`, bearer API-key only, streamable-HTTP).
- **`https://docs.vyomflow.co.in`** — published API reference and quickstart (Mintlify), including
  an in-browser playground that calls `/api/public/v1/*` with a pasted API key.

The apex domain `https://vyomflow.co.in` redirects (308) to `https://www.vyomflow.co.in`.

## Authentication

Two independent token types are accepted, verified independently of each other:

- **Session token** — first-party web app only. Clerk-issued, cookie/session-based, restricted to
  the frontend origin (`FRONTEND_ORIGIN`). Used by `/api/v1/*`.
- **API key** — for programmatic/agent access: the public REST API and MCP. Clerk-native
  (`clerkClient.apiKeys.create()`), scoped, expirable, and revocable. A signed-in user mints one at
  `https://www.vyomflow.co.in/settings/api-keys`. Keys are scoped to the Clerk instance that issued
  them and stop working if the app switches instances. Sent as `Authorization: Bearer <key>` —
  never as a query parameter.

## API documentation

Generated OpenAPI reference (from the request/response contracts in `src/contracts/**`, via
`pnpm docs:openapi`), published on Mintlify at **https://docs.vyomflow.co.in**, covering the public
REST API, MCP tools, and streaming/event semantics, with a live playground for the public surface.
