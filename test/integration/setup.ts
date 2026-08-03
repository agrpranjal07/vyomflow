import { afterAll, beforeEach } from "vitest";
import { testDb, truncateAll } from "../support/db";

beforeEach(async () => {
  await truncateAll();
});

// Each test file runs in its own forked process (see vitest.integration.config.mts)
// and therefore opens its own Prisma connection pool against the shared test
// Postgres. Without an explicit teardown, that pool's connections are only
// reclaimed when the forked process exits — closing them here bounds their
// lifetime to the file's own run instead of leaving them to linger.
afterAll(async () => {
  await testDb.$disconnect();
});
