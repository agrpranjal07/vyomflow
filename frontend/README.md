# VyomFlow Frontend

The frontend for VyomFlow: an agent workspace that runs tools, streams work, and keeps the ledger. Multi-turn conversations with a tool-using AI agent, file/media attachments, token-by-token streaming, and durable-run recovery across reloads, disconnects, and navigation.

## Stack

Next.js (App Router), React, TypeScript (strict), Tailwind CSS, Shadcn/ui, Zustand (client state),
TanStack Query (server state), Zod (contracts consumed from the backend), Clerk (auth),
Uppy + Transloadit (resumable uploads), `@tanstack/react-virtual` (message list), pnpm.

## Prerequisites

- Node.js 20+
- pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- The backend (VyomFlow backend) running and reachable — this app has no direct
  database or secret access of its own; every request goes through the backend's typed API

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in real values, see below
pnpm dev
```

Open [http://localhost:3001](http://localhost:3001). (Port 3001, not 3000 — the backend runs on
3000 in local dev.)

### Environment variables

See `.env.example` for the full list. In short:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth — page-level route protection; the backend independently verifies the bearer token on every request, this app's middleware is not a security boundary on its own |
| `NEXT_PUBLIC_BACKEND_API_URL` | Base URL of the backend API |
| `NEXT_PUBLIC_SITE_URL` | Site URL for OpenGraph and social metadata (optional, defaults to localhost) |
| `NEXT_PUBLIC_API_DOCS_URL` | Optional — the sidebar's "API / MCP" link; falls back to the backend repo's committed OpenAPI doc if unset |

## Scripts

```bash
pnpm dev               # start dev server on :3001
pnpm build             # production build (runs contracts:check first)
pnpm start             # run production build
pnpm lint              # lint
pnpm contracts:check   # verify the synced backend contracts haven't drifted or been hand-edited
```

## Architecture overview

**Contracts, not raw fetches.** Every request/response shape consumed here is a Zod schema synced
verbatim from the backend (`src/contracts/**`, checksum-pinned via `contracts.lock.json`) — service
modules call `Schema.parse(await res.json())` on every response, a real runtime check, not a type
assertion. `pnpm contracts:check` runs before every build and fails if the synced files were
hand-edited or have drifted from the backend's source contracts. All first-party network access goes
through centralized, typed service modules built on TanStack Query — no raw `fetch` calls are
scattered through components.

**Turn lifecycle on the client.** Sending a message calls the backend's send endpoint, which
returns immediately with a run ID and a realtime access token; the UI then subscribes to a
Trigger.dev Realtime text stream for token-by-token deltas plus a separate run-metadata stream for
status/tool/progress updates, reconciling both against the durable message state returned by REST.
On reload or when switching chats, the client asks the backend for the chat's currently active run
(server-owned state) and resumes the realtime subscription from the run's last durably-persisted
stream index — never restarting a generation, never duplicating or dropping streamed content.
Reconnection uses bounded retries with token refresh (the realtime access token defaults to a short
expiry) and falls back to REST reconciliation if the realtime transport itself is unavailable.

**Message list.** Virtualized with `@tanstack/react-virtual` so long conversations stay smooth
regardless of history length, while dynamic row measurement keeps the currently-streaming message's
growing height accurate and the composer stays pinned to the bottom of the viewport. Content blocks
(text, thinking/reasoning, tool_use, tool_result, citations, usage) render in persisted order, and
failed or cancelled turns remain visible, explainable, and retryable rather than disappearing.

**Attachments.** Uploads go through Uppy with the Transloadit plugin and tus resumable uploads;
the backend signs each assembly so the Transloadit secret never reaches this app. Upload progress,
cancellation, retry, and stable ordering are preserved through to the persisted attachment, and
generated media (images/video/audio) from agent tool calls renders through the same durable-asset
path as directly uploaded attachments.

**Credits and approvals.** A credits pill/popover surfaces balance, held amount, and a
per-run usage breakdown sourced from the backend's ledger endpoints. Waitpoints (a
credit-approval gate above a threshold, or an agent clarification question) render as an inline
approval overlay that blocks further input until resolved, tolerates a duplicate submission
without double-charging, and expires safely with a clear "how to continue" message if left
unanswered.

## Design decisions and trade-offs

- **A committed, checksum-verified copy of the backend's contracts, not a live fetch or a
  published package.** This keeps the frontend build fully decoupled from a live backend
  deployment (no first-deploy bootstrap ordering problem) while still making drift impossible to
  ship silently — `contracts:check` fails the build if the synced files disagree with their
  checksums. The trade-off is a manual re-sync step (`pnpm contracts:sync`, run from the backend
  repo) whenever the backend's contracts change.
- **Virtualization added at the message-list layer, not the page.** `@tanstack/react-virtual`
  wraps only the scrollable message region, leaving the pinned composer, load-older-messages
  control, and approval overlay outside the virtualized range — this keeps their behavior (and the
  scroll-anchoring needed when older messages are prepended) simple to reason about independently
  of row virtualization.
- **Client-owned connection state never overrides server-confirmed terminal state.** A
  `reconnecting`/`connection lost` flag exists purely to inform the user about transport health; the
  moment a REST reconciliation or realtime payload confirms a run reached a terminal status, the UI
  reflects that immediately even if the local flag hasn't cleared yet — avoiding a stale "still
  connecting" state masking a run that has, in fact, already finished.
