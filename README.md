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

`docs/` holds the public API reference (Mintlify), including the generated OpenAPI document at
`docs/openapi.json` — regenerate it from the backend with `pnpm docs:openapi`.
