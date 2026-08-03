import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Next.js conventionally reads `.env.local`; the Prisma CLI is a separate
// process and does not load it automatically.
loadEnv({ path: ".env.local" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read via raw `process.env`, not the throwing `env()` helper — the
    // provider is hardcoded in schema.prisma, so `prisma generate` never
    // actually needs a resolvable DATABASE_URL, only for it not to throw.
    // Trigger.dev's dashboard-configured env vars are runtime-only and are
    // never injected into the image build container (confirmed against
    // Trigger.dev's own docs: "made available to your tasks at runtime,
    // rather than being injected into the image build container"), so
    // `postinstall`'s `prisma generate` had no DATABASE_URL at all and
    // failed the whole build before ever reaching app code — same failure
    // class already fixed once for shadowDatabaseUrl below.
    url: process.env.DATABASE_URL,
    // Scratch DB for non-interactive `prisma migrate diff` (this
    // environment can't run the interactive `migrate dev`). Genuinely
    // optional — read via raw `process.env`, not the `env()` helper, which
    // throws `PrismaConfigEnvError` on ANY unresolved variable regardless of
    // its declared TS type, including during `prisma generate`'s own
    // `postinstall` run where no shadow database is needed at all (broke
    // Vercel builds, which never set this var — confirmed against Prisma's
    // own docs recommending `process.env` for this exact optional case).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
