# Migrations — forward/rollback notes & compatibility assumptions

## `20260819103643_init`

**Forward:** creates `users`, `chats`, `messages`, `agent_runs`, their enums
(`MessageRole`, `MessageStatus`, `AgentRunStatus`), foreign keys (`ON DELETE CASCADE` from
`chats`→`users`, `messages`→`chats`, `agent_runs`→`chats`), and every S1 index — including the
partial unique index `agent_runs_chatId_key` (`WHERE status IN ('queued','running','waiting')`)
that enforces at most one non-terminal `AgentRun` per chat at the database level.

**Rollback:** destructive — `prisma migrate resolve --rolled-back 20260819103643_init` followed by
`DROP TABLE agent_runs, messages, chats, users CASCADE; DROP TYPE "MessageRole", "MessageStatus",
"AgentRunStatus";` on an environment where no other migration depends on these tables yet (true at
this point in the project). Do not roll back once S2+ has added FKs to `agent_runs`/`messages`
without also rolling those forward migrations back first.

**Compatibility assumptions:**
- PostgreSQL ≥ 13 (partial/expression indexes, `JSONB`, standard `TIMESTAMP(3)` — nothing here needs
  a newer feature; the committed `docker-compose.yml` uses `postgres:17-alpine`).
- `agent_runs` and `messages` are created now with only the columns S1 needs; S2 is expected to add
  columns to `agent_runs` (e.g. tool/credit fields) via `ALTER TABLE`, not a table rewrite — no
  breaking migration anticipated for that slice.
- Enum labels (`queued`, `running`, `waiting`, …) are referenced **verbatim** by the partial index's
  `WHERE` predicate (`prisma/schema.prisma`'s `@@unique(..., where: raw(...))`). Renaming an
  `AgentRunStatus` member requires updating that predicate string in the same migration — Prisma
  does not do this automatically since the predicate is opaque raw SQL to the schema engine.

## `20260819125216_s2_streaming_turn`

**Forward:** adds S2's durable-turn columns to `agent_runs` (`userMessageId`/`assistantMessageId`/
`triggerRunId` unique identity columns, `cancelRequestedAt`, `startedAt`/`finishedAt`,
`requestedModel`/`resolvedModel`, `errorCode`/`errorMessage`, `turnCount`); flips
`lastStreamIndex`'s default `0 → -1` (see `.claude/specs/S2-streaming-turn.md` — `-1` means "no
stream part persisted yet" so the trigger.dev-react-hooks resume contract `startIndex:
lastStreamIndex + 1` never skips part 0, since `startIndex` is inclusive/0-based); adds
`@@index([status, updatedAt])` for the stale-run reconciler; creates `credit_holds`,
`credit_ledger`, `rate_limit_windows` with their enums (`CreditHoldStatus`, `CreditLedgerKind`);
flips `users.creditBalance`'s default `0 → 100.0000` (stated assumption — open question Q5 was
never answered upstream — see `00-master-spec.md` §4 / S2 implementation plan §C). The partial unique index
on `agent_runs.chatId` is dropped and recreated verbatim (Postgres has no `ALTER INDEX ... ADD
COLUMN`; unrelated to the predicate itself, which is unchanged).

**Rollback:** the three new tables can be dropped independently
(`DROP TABLE credit_ledger, credit_holds, rate_limit_windows CASCADE; DROP TYPE "CreditLedgerKind",
"CreditHoldStatus";`). Rolling back the `agent_runs` column adds requires first confirming no row
has been written by S2 code (the new `userMessageId`/`assistantMessageId`/`triggerRunId` columns are
`UNIQUE`, `userMessageId` is `NOT NULL` — a straight `ALTER TABLE ... DROP COLUMN` is safe only while
the table is still empty, which is the state this migration was applied against).

**Compatibility assumptions:** carries forward the `20260819103643_init` assumptions above
unchanged. `userMessageId` is added `NOT NULL` without a default — safe only because `agent_runs`
had zero rows at migration time (verified via `docker exec ... psql -c "SELECT count(*) FROM
agent_runs"` before applying); any environment where `agent_runs` already has rows needs a backfill
step before this migration, not a bare `ALTER TABLE`.

## `20260820120000_s3_tool_invocations`

**Forward:** creates `tool_invocations` (the `ToolInvocation` entity, backing the typed tool
registry) with its `ToolInvocationStatus` enum
(`DISPATCHING|QUEUED|RUNNING|COMPLETED|FAILED|CANCELLED`), FK to `agent_runs` (`ON DELETE CASCADE`),
the duplicate-dispatch guard `UNIQUE(agentRunId, toolCallId)`, and `@@index([status, updatedAt])` for
S6's future reconciliation sweep. Adds `credit_holds.capturedAmount` (`DEFAULT 0`, additive — S2's
existing rows are unaffected since no S2 path ever captures). Adds a real FK
`credit_ledger.toolInvocationId → tool_invocations.id` (`ON DELETE SET NULL`, matching the existing
`credit_ledger.runId` FK's append-only-audit posture — never `CASCADE`, so deleting a `ToolInvocation`
can never silently delete its own ledger history). The partial unique index on `agent_runs.chatId` is
dropped and recreated verbatim again, for the same reason as `20260819125216_s2_streaming_turn`
(Postgres has no in-place `ALTER INDEX` for a partial index; the predicate itself is unchanged).

**Rollback:** `tool_invocations` can be dropped independently once empty
(`DROP TABLE tool_invocations CASCADE; DROP TYPE "ToolInvocationStatus";`) — safe at any point before
S3 dispatch code writes a row. Rolling back `credit_holds.capturedAmount` is a bare
`ALTER TABLE credit_holds DROP COLUMN "capturedAmount"`, safe unconditionally since it has a default
and no S3 code has run yet to populate non-zero values. Rolling back the `credit_ledger` FK requires
dropping the constraint before the column, in that order.

**Compatibility assumptions:** carries forward all assumptions above unchanged. This migration was
generated non-interactively via `prisma migrate diff --from-migrations ... --to-schema ... --script`
against a disposable `SHADOW_DATABASE_URL` scratch database (this environment cannot run the
interactive `prisma migrate dev`) — `prisma.config.ts` gained an optional `shadowDatabaseUrl` for
this purpose; unset in any environment that doesn't need `migrate diff`, harmless when absent.
