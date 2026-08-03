import { prisma } from "@/lib/db";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set to run integration tests (see .env.local).");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL — refusing to truncate the dev database.");
}

// `@/lib/db`'s singleton already points at TEST_DATABASE_URL under
// NODE_ENV=test (see src/lib/db.ts) — reused here rather than opening a
// second connection pool to the same database.
export const testDb = prisma;

/** Clears all app tables between tests without dropping/recreating the schema. */
export async function truncateAll() {
  await testDb.$executeRawUnsafe(
    'TRUNCATE TABLE "credit_ledger", "credit_holds", "rate_limit_windows", "agent_runs", "attachments", "messages", "chats", "users" RESTART IDENTITY CASCADE;',
  );
}
