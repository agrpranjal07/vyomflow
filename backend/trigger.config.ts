import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { additionalFiles, ffmpeg } from "@trigger.dev/build/extensions/core";
import type { BuildExtension } from "@trigger.dev/core/v3/build";
import { AGENT_TURN_MAX_DURATION_S } from "./src/lib/config";

// Verified against the actually-installed @trigger.dev/sdk 4.5.11 /
// @trigger.dev/build 4.5.11 (S2 implementation session, 2026-08-19) — see
// .claude specs' S2 implementation plan §D/§M. `mode: "modern"` is
// documented explicitly for "Prisma 6.16+/7.x with the `prisma-client`
// provider... using database adapters (e.g. @prisma/adapter-pg)", which is
// exactly this project's setup; it marks @prisma/client external with zero
// extra config and requires only that `prisma generate` already ran
// (already wired via `postinstall`). This resolves the "unverified" risk
// flagged during planning — confirmed, not assumed.

/**
 * Resolves this project's single `@/* -> ./src/*` tsconfig path alias for
 * Trigger.dev's esbuild-based bundler, which does NOT read tsconfig
 * `paths` the way Next.js does (discovered live: `npx trigger.dev dev`
 * failed with "Cannot find module @/lib/db" etc. for every `@/...` import
 * reachable from src/trigger/turn.ts, even though `pnpm build`/`pnpm lint`
 * are clean — Next's TS compiler and esbuild resolve modules differently).
 * `@trigger.dev/build` ships no tsconfig-paths extension of its own; this
 * is the smallest fix for this project's one alias, not a general-purpose
 * resolver — verified against the installed `BuildExtension`/`BuildContext`
 * types (`context.registerPlugin` accepts a standard esbuild `Plugin`).
 */
function tsconfigPathsExtension(): BuildExtension {
  return {
    name: "tsconfig-paths-alias",
    onBuildStart(context) {
      context.registerPlugin({
        name: "resolve-at-alias",
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) => {
            const relative = args.path.slice(2);
            const base = join(context.workingDir, "src", relative);
            const candidate = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((path) =>
              existsSync(path),
            );
            return { path: candidate ?? `${base}.ts` };
          });
        },
      });
    },
  };
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  dirs: ["./src/trigger"],
  runtime: "node-22",
  // This used to be a bare `300`, which was strictly less than agentTurn's
  // own task-level maxDuration override (previously an inline
  // MEDIA_TOOL_TASK_MAX_DURATION_S + 60 expression, ~450s) — an
  // undocumented, unverified assumption about which value Trigger.dev
  // actually honors. Now both this global default and turn.ts's per-task
  // override derive from the same AGENT_TURN_MAX_DURATION_S constant, so
  // the two can never silently drift apart again regardless of precedence.
  maxDuration: AGENT_TURN_MAX_DURATION_S,
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3 },
  },
  build: {
    // `agent-skills/` is read from disk at runtime (server/skills/registry.ts
    // via getApprovedSkillsRoot, `path.resolve(process.cwd(), "agent-skills")`)
    // rather than imported, so Trigger.dev's esbuild bundler never traces it
    // into the deploy bundle on its own — confirmed live: agent-turn failed
    // in prod with "ENOENT: no such file or directory, realpath
    // '/app/agent-skills'". additionalFiles copies it into the build output
    // at the same project-root-relative path the runtime already expects.
    extensions: [
      tsconfigPathsExtension(),
      prismaExtension({ mode: "modern" }),
      additionalFiles({ files: ["./agent-skills/**"] }),
      // merge_videos (media-tool task) shells out to ffmpeg/ffprobe — this
      // extension installs a static FFmpeg 7 and sets FFMPEG_PATH/FFPROBE_PATH
      // in the deployed build (VyomFlow plan §B3/§B4).
      ffmpeg(),
    ],
    // sharp is a native module (prebuilt platform-scoped binary) and must
    // never be bundled by esbuild — VyomFlow plan §B4.
    external: ["sharp"],
  },
});
