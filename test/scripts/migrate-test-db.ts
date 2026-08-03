/**
 * Test-infrastructure script (centralized workspace, never committed to
 * either app repo). Applies backend's already-committed migrations to the
 * isolated test database (TEST_DATABASE_URL), never the dev one. Invokes
 * backend's own locally-installed Prisma CLI against backend's own schema
 * — this workspace does not duplicate the schema or own migration state,
 * it only directs the existing application tooling. Run before integration
 * tests — wired as `pretest:integration` in test/package.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: join(__dirname, "..", ".env.local") });

const backendPath = process.env.BACKEND_PATH ?? join(__dirname, "..", "..", "backend");
const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
  throw new Error("TEST_DATABASE_URL must be set in test/.env.local.");
}
if (testUrl === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL — refusing to migrate the dev database as test.");
}

const prismaBin = join(backendPath, "node_modules", ".bin", "prisma");
if (!existsSync(prismaBin)) {
  throw new Error(`Backend Prisma CLI not found at ${prismaBin} — run \`pnpm install\` in backend/ first.`);
}

execFileSync(prismaBin, ["migrate", "deploy"], {
  cwd: backendPath,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});
