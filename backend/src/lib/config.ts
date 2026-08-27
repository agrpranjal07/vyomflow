/**
 * S2 env-configurable constants. Kept in one place per
 * ui-architecture-policy.md's "centralize application-level configuration"
 * principle, applied here to backend runtime tuning rather than UI tokens.
 * Every value has a stated default and a comment on why it exists —
 * changing one requires editing this file only, not hunting through
 * services/routes.
 */

/**
 * New-user starting balance and the LLM-only admission hold amount.
 * The reference product never answered open question Q5 (starting balance;
 * whether app credits mirror the reference implementation's M units 1:1).
 * Stated assumption, not a silent one — see .claude/specs/S2-streaming-turn.md
 * and the S2 implementation plan §C: app credits are denominated 1:1 with
 * the reference implementation's M units. The starting
 * balance itself is also baked into prisma/schema.prisma's
 * `User.creditBalance @default(100.0000)` so a fresh row matches this
 * constant without a runtime read; this export exists for anything that
 * needs the value in code (e.g. tests, future admin tooling).
 */
export const CREDIT_STARTING_BALANCE = 100.0;

/**
 * Public-facing base URL of this API (`/api/public/v1/*`, `/api/mcp`,
 * OpenAPI `servers`), env-driven so a Preview/Production move is a config
 * change only. No hardcoded production default — see the fail-fast
 * assertion below.
 */
export const PUBLIC_API_BASE_URL = (process.env.PUBLIC_API_BASE_URL ??
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000")) as string;

/**
 * CLAIM_AUDIT flagged FRONTEND_ORIGIN silently defaulting to localhost in
 * production (lib/http.ts / lib/auth.ts). Fail fast at module load rather
 * than serving CORS/auth against the wrong origin indefinitely.
 */
if (process.env.NODE_ENV === "production" && (!process.env.FRONTEND_ORIGIN || !PUBLIC_API_BASE_URL)) {
  throw new Error("FRONTEND_ORIGIN and PUBLIC_API_BASE_URL must be set in production.");
}

/**
 * Minimum refundable admission reserved on send for the LLM-only path (no
 * tools yet — S3 adds per-tool pre-dispatch estimates). Chosen against the
 * reference product's observed ~0.04M cost for one text turn
 * (.claude/evidence/reference-chat-response-rendered.md), rounded down
 * since the actual OpenRouter cost is always 0 credits
 * (00-master-spec.md §4 — "record OpenRouter usage at zero application
 * credits") and the hold is released in full at finalize regardless.
 */
export const CREDIT_LLM_MIN_ADMISSION = 0.01;

/** Application-level per-user send-rate limit (S2-streaming-turn.md) —
 * distinct from, and in addition to, OpenRouter's own upstream 429s.
 * Fixed-window: at most MAX_SENDS_PER_WINDOW sends per
 * RATE_LIMIT_WINDOW_MS per user.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_SENDS = 10;

/**
 * Hard cap on agent-loop iterations per turn — defensive against a model
 * that never emits a terminal finish_reason (S2-streaming-turn.md "Max-turn
 * protection").
 */
export const MAX_AGENT_TURNS = 8;

/**
 * How long a non-terminal AgentRun can go without a status/updatedAt write
 * before the lazy reconciler treats it as possibly CRASHED/orphaned and
 * checks Trigger.dev directly (S2 implementation plan §B Contradiction 2,
 * §F). Comfortably above one full streaming turn's expected duration.
 */
export const RUN_STALE_AFTER_MS = 5 * 60_000;

/**
 * Hard backstop, independent of what Trigger.dev's own API reports.
 * Verified live (S2 completion-gate session, 2026-08-19): a hard-killed
 * *local dev* worker process does not reliably flip its run to CRASHED on
 * Trigger.dev Cloud within any practical window — `runs.retrieve()` kept
 * reporting `EXECUTING` 10+ minutes after the process was confirmed dead,
 * because local dev lacks the infrastructure-level health checks a
 * deployed worker gets. Trusting that upstream signal indefinitely would
 * violate the spec's own "never leaves an AgentRun stuck running forever"
 * requirement. Once a run has been stale by our own clock for this long
 * (well past `maxDuration` in trigger.config.ts plus generous slack), the
 * reconciler fails it closed regardless of what Trigger.dev reports.
 */
export const RUN_ORPHAN_HARD_TIMEOUT_MS = 15 * 60_000;

/**
 * Bound on `triggerRuns.retrieve()` inside `reconcileIfStale` — the
 * installed SDK's `ApiRequestOptions` exposes no per-call `signal`/timeout
 * field, so a stalled request would otherwise hang the calling run/send
 * read indefinitely instead of reaching the existing null-fallback path.
 */
export const TRIGGER_RETRIEVE_TIMEOUT_MS = 10_000;

/**
 * Trigger.dev Realtime public-access-token lifetime. Always passed
 * explicitly to `auth.createPublicToken({ expirationTime })` — the SDK's
 * own default is not verifiable from the shipped types, so nothing may
 * rely on it (S2 implementation plan §G). `_MS` drives the `expiresAt`
 * the frontend uses to schedule its refresh-before-expiry timer;
 * `_DURATION` is the SDK's own duration-string format for the same value —
 * kept as one pair, not two independently-editable literals.
 */
export const REALTIME_TOKEN_TTL_MS = 15 * 60_000;
export const REALTIME_TOKEN_TTL_DURATION = "15m";

/**
 * Hard deadline on the outgoing OpenRouter request itself (connect through
 * full stream completion) — independent of the task's own cancellation
 * `signal` and `maxDuration`. Without this, a request OpenRouter never
 * responds to (or a stream it never closes) can hang the fetch
 * indefinitely; `maxDuration` is a Trigger.dev task-level backstop, not a
 * substitute for bounding the network call itself. Comfortably above
 * `MAX_AGENT_TURNS` iterations of one real completion each.
 */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Hard cap on how many of a chat's most-recent messages are sent to
 * OpenRouter as conversation history (hardening pass — previously
 * unbounded). Ordered oldest-first after the cap is applied, so the model
 * always sees a contiguous, chronological window ending at the message
 * this turn was dispatched for.
 */
export const MAX_CONVERSATION_HISTORY_MESSAGES = 40;

/**
 * Progressive-persistence throttle for streamed deltas (hardening pass):
 * `persistDelta` previously ran a full-message-rewrite transaction on
 * every single token. Checkpointing every N deltas or T ms (whichever
 * comes first) cuts DB write volume roughly by a factor of N during a long
 * completion while still bounding how much progress a mid-stream crash can
 * lose, and bounding cancellation-detection latency to the same window.
 * The realtime `write()` to the live stream is NOT throttled — only the
 * durable DB checkpoint is — and a final unconditional checkpoint always
 * flushes the true end-of-loop state (src/trigger/turn.ts), so no
 * completed/failed/truncated outcome can end up with stale persisted text.
 */
export const STREAM_CHECKPOINT_EVERY_N_DELTAS = 20;
export const STREAM_CHECKPOINT_INTERVAL_MS = 500;

/**
 * S7 — Transloadit ingestion poll deadline, declared here (ahead of its
 * sibling Transloadit constants below) because `MEDIA_TOOL_TASK_MAX_DURATION_S`
 * must budget for it and `const` has no hoisting — referencing it from below
 * would throw at module load. Hard deadline per outbound Transloadit HTTP
 * call (createAssembly / each status poll) — audit finding H2: neither
 * fetch previously carried a timeout, so a single hung socket could outlast
 * this poll deadline entirely and never surface as `TransloaditTimeoutError`.
 */
export const TRANSLOADIT_POLL_DEADLINE_MS = 60_000;
export const TRANSLOADIT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * VyomFlow — media-tool timing budgets, replacing the reference
 * implementation's remote poll deadline as the thing each tool's own
 * execution is bounded by (crop/generate/merge now run in-process against
 * sharp/Cloudflare Workers AI/ffmpeg instead of being dispatched to a remote
 * run).
 */

/** Hard deadline on a single sharp `.extract()` crop call (`crop_image`). */
export const SHARP_CROP_BUDGET_MS = 30_000;

/** Hard deadline on a single Cloudflare Workers AI image-generation call (`generate_image`). */
export const GENERATE_IMAGE_BUDGET_MS = 120_000;

/** Alias of GENERATE_IMAGE_BUDGET_MS, used at the Cloudflare fetch call site — same value, named for what it bounds there. */
export const CLOUDFLARE_REQUEST_TIMEOUT_MS = GENERATE_IMAGE_BUDGET_MS;

/** Hard deadline on the ffmpeg merge itself (`merge_videos`) — the largest of the three, since it's proportional to input size/count. */
export const MERGE_VIDEOS_BUDGET_MS = 300_000;

/** Hard deadline on downloading a media tool's source URL(s) into `workDir` before the engine runs. */
export const MEDIA_SOURCE_DOWNLOAD_BUDGET_MS = 120_000;

/** Hard deadline on a media tool's entire `execute()` — download + engine work — independent of the per-call budgets above, which bound individual steps within it. */
export const MEDIA_TOOL_EXEC_DEADLINE_MS = 300_000;

/**
 * The media-tool child task's own Trigger.dev `maxDuration` — exec deadline +
 * Transloadit ingestion poll deadline + dispatch/round-trip slack, landing on
 * 390s by construction.
 */
export const MEDIA_TOOL_TASK_MAX_DURATION_S =
  Math.ceil(MEDIA_TOOL_EXEC_DEADLINE_MS / 1000) + Math.ceil(TRANSLOADIT_POLL_DEADLINE_MS / 1000) + 30;

/**
 * Pre-dispatch credit-hold estimates per tool (D2 — grows the run's hold
 * before dispatch; capture always settles at this fixed estimate, since
 * in-process engines report no per-call cost of their own). Recon's pricing
 * table and one real observed reference-implementation run
 * disagreed by ~20x for crop_image (Q-E, recon-findings.md "Session-5") —
 * these use the higher, real-observed figures so the pre-dispatch headroom
 * check never under-reserves against actual settlement.
 */
export const TOOL_CREDIT_ESTIMATE: Record<string, number> = {
  crop_image: 0.1,
  generate_image: 0.1,
  merge_videos: 0.05,
};

/**
 * S7 — Transloadit signed-Assembly asset ingestion. Both Templates below
 * already exist in Transloadit (created out-of-band) and both name their
 * result step `stored` — `TRANSLOADIT_RESULT_STEP` is the single lookup key
 * used against `results` on every Assembly status read.
 */
export const TRANSLOADIT_API_BASE_URL = "https://api2.transloadit.com";

// S4 user-upload-store — wired for a later slice, not used by S7 ingestion.
export const TRANSLOADIT_UPLOAD_TEMPLATE_ID = process.env.TRANSLOADIT_UPLOAD_TEMPLATE_ID ?? "6dcc633bc81c4ea49bfcb5ca0e9e462a";
// S7 generated-asset-ingest — the Template this task's ingestion path uses.
export const TRANSLOADIT_INGEST_TEMPLATE_ID = process.env.TRANSLOADIT_INGEST_TEMPLATE_ID ?? "050c3ae0e2cf423a9cf7dc7f5d8eb808";
// VyomFlow — direct buffer/file-stream upload for locally-produced media
// artifacts (crop/generate/merge output bytes never had a source URL to
// /http/import), Template `vyomflow-generated-upload`, created live 2026-08-26.
export const TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID = process.env.TRANSLOADIT_GENERATED_UPLOAD_TEMPLATE_ID ?? "62b321e9c3a44faeb195263cf9cbc0f2";
export const TRANSLOADIT_RESULT_STEP = "stored";

/** Signed-params `auth.expires` TTL — how long a signed Assembly request stays valid. */
export const TRANSLOADIT_ASSEMBLY_SIGN_TTL_MS = 5 * 60_000;

/** Poll cadence for an Assembly status read — ingesting an already-generated file should be fast. Deadline declared earlier in this file (see comment there). */
export const TRANSLOADIT_POLL_INTERVAL_MS = 1_500;

/**
 * S6 (.claude/specs/S6-reliability-implementation-plan.md §7.1) — the
 * pre-dispatch credit-threshold that gates a tool call behind a
 * CREDIT_APPROVAL waitpoint instead of dispatching immediately. Set between
 * merge_videos' (0.05) and crop_image's/generate_image's (0.1) estimates
 * (TOOL_CREDIT_ESTIMATE above) so at least one of the three real tools
 * crosses it under ordinary use — the plan's own §14 risk note that
 * this must not silently never fire in the demo.
 */
export const APPROVAL_CREDIT_THRESHOLD = 0.08;

/**
 * Trigger.dev `wait.forToken` timeout for both Waitpoint kinds
 * (CREDIT_APPROVAL and CLARIFICATION) — the SDK's own documented default is
 * 10 minutes (recon-findings.md); kept as an explicit named constant here
 * rather than relying on an unstated SDK default, matching this file's own
 * "never trust an unverifiable default" convention (REALTIME_TOKEN_TTL_MS
 * above uses the same reasoning).
 */
export const WAITPOINT_TIMEOUT_MS = 10 * 60_000;

/**
 * Defensive cap on ask_user calls within a single turn (S6 plan §14 risk:
 * "nothing stops a poorly-prompted model from calling it on every turn").
 * Mirrors MAX_AGENT_TURNS' existing runaway-loop protection style.
 */
export const MAX_ASK_USER_CALLS_PER_TURN = 3;

/**
 * S6 scheduled reconciliation sweep (§7.3) — interval between sweep runs,
 * and the staleness threshold for a ToolInvocation stuck
 * DISPATCHING/RUNNING/QUEUED before it's fail-closed to FAILED (all tool
 * work is in-process now, so a stale row means the owning worker is gone).
 *
 * Must stay above MEDIA_TOOL_TASK_MAX_DURATION_S: `ToolInvocation.updatedAt`
 * is only bumped at the RUNNING transition, not on a heartbeat, so a row for
 * a legitimately-still-executing media-tool task (e.g. a `merge_videos` run
 * using its full ~300s engine budget) looks exactly as stale as a truly
 * orphaned one until the task's own maxDuration elapses. Deriving this from
 * MEDIA_TOOL_TASK_MAX_DURATION_S (with slack) rather than a bare literal
 * keeps that relationship enforced if the budgets above ever change —
 * verified separately in config-invariants.test.ts. Still deliberately
 * shorter than RUN_ORPHAN_HARD_TIMEOUT_MS: a tool dispatch stuck this long,
 * independent of the parent run's own state, is itself the more specific
 * signal.
 */
export const SWEEP_INTERVAL_MS = 60_000;
export const TOOL_ORPHAN_TIMEOUT_MS = (MEDIA_TOOL_TASK_MAX_DURATION_S + 60) * 1000;

/**
 * Per-query row cap for every sweep.ts findMany (S7 plan §4.4/§6.5) — the
 * sweep runs every minute and does not need to drain a backlog in one pass;
 * a flat per-pass cost bounded by this constant beats an unbounded scan that
 * grows linearly with concurrent load.
 */
export const SWEEP_BATCH_SIZE = 500;

/**
 * Grace period after a cancel request before the cancel route's own inline
 * reconciliation attempt gives up and defers to the general sweep (§7.2) —
 * deliberately much shorter than RUN_STALE_AFTER_MS (5 min): a user who
 * clicked Stop should see it resolve fast, not wait for the general
 * staleness window meant for silent/undetected staleness.
 */
export const CANCEL_GRACE_MS = 15_000;

/**
 * Grace period before an empty (message-less) chat is hard-deleted by the
 * sweep. A chat row can legitimately exist for a short window with no
 * messages yet — the public-API/MCP "create chat" call is a separate step
 * from sending into it, and a UI double-submit race can momentarily create
 * a second one (see empty-state.tsx's pendingChatIdRef) — but one that
 * never receives a first message is an orphan, never a draft worth keeping
 * indefinitely. An hour is generous enough that no genuine create-then-send
 * caller trips it, short enough that orphans don't accumulate.
 */
export const EMPTY_CHAT_ORPHAN_TIMEOUT_MS = 60 * 60_000;

/**
 * The agentTurn Trigger.dev task's own maxDuration, named explicitly so
 * trigger.config.ts's global default and turn.ts's task-level override can
 * both reference the same source of truth instead of two independently
 * editable literals that silently drifted (S6 plan §7.6 / §2.2 — global was
 * 300s, task-level was an inline 450s expression, undocumented which wins).
 */
// Derives from MEDIA_TOOL_TASK_MAX_DURATION_S (media-tool's own
// maxDuration), landing on 450s by construction — see that constant's comment.
export const AGENT_TURN_MAX_DURATION_S = MEDIA_TOOL_TASK_MAX_DURATION_S + 60;

/**
 * S7 (§4.6/§6.4) — Trigger.dev queue bounds. Neither task declared a `queue`
 * before this, so there was no per-user concurrency bound at all and a single
 * user with many chats could occupy the entire worker pool; 00-master-spec.md
 * §11's "horizontally scaled by Trigger.dev's own worker pool" claim rested on
 * the *absence* of a limit rather than on a real one.
 *
 * These are PER-USER limits, not global ones. Both tasks declare a named queue
 * carrying the limit, and every trigger site passes `concurrencyKey: userId` —
 * verified against the installed @trigger.dev/sdk 4.5.11 types, whose own
 * `concurrencyKey` doc comment states it "creates a copy of the queue for every
 * unique value of the key... each user will have their own queue with a
 * concurrency limit of 10". Per-user fairness was the actual missing bound; the
 * *global* ceiling already exists and is enforced upstream as the Trigger.dev
 * environment-level concurrency limit, which is a deployment/plan setting and
 * deliberately not restated in code (a task may declare only one queue, so
 * duplicating the global cap here would have cost us the fairness bound).
 *
 * Deadlock-safety: agent-turn suspends on `triggerAndWait` (media-tool) and on
 * `wait.forToken` (approval/clarification waitpoints). Trigger.dev v4 releases a
 * run's concurrency slot when it checkpoints into WAITING, so a parent waiting on
 * its own child cannot starve the queue it would need to resume — confirmed in
 * the v4 "Waits and concurrency" docs before these limits were introduced.
 *
 * Values are deliberately generous rather than clever: throttling the demo is a
 * worse failure than admitting one extra concurrent turn.
 */
export const AGENT_TURN_QUEUE_CONCURRENCY = 5;

/**
 * Matched to AGENT_TURN_QUEUE_CONCURRENCY on purpose. `buildToolExecutor`
 * (src/trigger/turn.ts) runs a round's tool calls sequentially, so one user's
 * in-flight media-tool children can never exceed their in-flight turns —
 * meaning this limit is a defense-in-depth backstop today, not an active
 * throttle. It becomes the real limiter the moment tool dispatch within a
 * turn is parallelized, which is exactly when it should be raised
 * deliberately rather than discovered as a mystery stall.
 */
export const MEDIA_TOOL_QUEUE_CONCURRENCY = AGENT_TURN_QUEUE_CONCURRENCY;

/**
 * S8 Phase 6 — signed outbound webhooks. Hard timeout on the single
 * outbound HTTP call to a receiver (bounded, independent of the child
 * task's own `maxDuration`/retry schedule — see server/webhooks/retry.ts
 * for the retry backoff itself) and a small, best-effort-side-channel
 * concurrency bound on the `webhook-delivery` queue.
 */
export const WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS = 10_000;
export const WEBHOOK_DELIVERY_QUEUE_CONCURRENCY = 10;
