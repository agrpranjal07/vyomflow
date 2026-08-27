# VyomFlow

VyomFlow is an agent workspace: multi-turn conversations with a tool-using AI agent, real media
tools (image crop, image generation, video merge), file/media attachments, token-by-token
streaming, and durable-run recovery across reloads, disconnects, and navigation. PostgreSQL is the
durable source of truth; Trigger.dev Realtime is the transport for live updates.

## Layout

```
frontend/   Next.js (App Router) client — chat UI, attachments, credits, streaming
backend/    Next.js Route Handlers as the REST API — Prisma/PostgreSQL, agent runs, tool execution
test/       Centralized test workspace — unit, integration, and frontend test suites
docs/       Public API documentation (Mintlify) — quickstart, concepts, API reference
```

See `frontend/README.md` and `backend/README.md` for each app's stack, setup, environment
variables, and architecture notes.

## Surfaces

- `https://www.vyomflow.co.in` — first-party browser app, Clerk session-cookie auth.
- `https://api.vyomflow.co.in` — the internal API (`/api/v1/*`, session-token only), a public REST
  API (`/api/public/v1/*`, bearer API-key only), and an MCP server (`/api/mcp`, bearer API-key
  only). The apex `https://vyomflow.co.in` redirects (308) to the `www` host.
- `https://docs.vyomflow.co.in` — published Mintlify docs and API playground, talking to
  `/api/public/v1/*` with a bearer API key.

A signed-in user mints an API key at `https://www.vyomflow.co.in/settings/api-keys` for
programmatic/agent access (public REST + MCP); the browser app itself uses session auth only.

## Prerequisites

- Node.js 20+
- pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- PostgreSQL (a `docker-compose.yml` is included under `backend/` for local dev/test databases)
- A Trigger.dev project (free tier) for durable task execution
- Clerk, OpenRouter, Transloadit, and Cloudflare Workers AI accounts (all have usable free tiers)

## Getting started

```bash
# backend
cd backend
pnpm install
cp .env.example .env.local   # fill in real values
pnpm prisma:migrate
pnpm dev                     # runs on :3000

# frontend (separate shell)
cd frontend
pnpm install
cp .env.example .env.local
pnpm dev                     # runs on :3001

# tests (separate shell)
cd test
pnpm install
pnpm test:unit
pnpm test:frontend
pnpm test:integration        # requires the backend's Postgres running
```

## API documentation

`docs/` holds the public API reference (Mintlify, published at `https://docs.vyomflow.co.in`),
including the generated OpenAPI document at `docs/openapi.json` — regenerate it from the backend
with `pnpm docs:openapi`, never hand-edit it.
