import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  mergeVideosTool,
  FfmpegExecutionError,
  MergeVideosValidationError,
} from "@/server/tools/adapters/merge-videos";
import { MergeVideosInputSchema } from "@/contracts/tools";
import { TOOL_CREDIT_ESTIMATE } from "@/lib/config";

// merge-videos.ts downloads via lib/safe-download.ts's openSafeStream,
// which pins the TCP connection to a DNS-resolved, SSRF-validated address
// (see lib/safe-download.ts) — real production behavior, but one that pins
// past the hostname MSW would otherwise match a mock request on, so an
// MSW-based fixture server can't intercept it. Mocked directly here instead:
// these tests need real bytes flowing into a real file for real ffmpeg to
// process, not real HTTP framing, so a Readable over the fixture bytes is
// exactly the right fidelity. safe-download.ts's own SSRF/DNS/redirect
// validation logic is covered independently by unit/safe-download.test.ts.
const fixtureRoutes = new Map<string, string>();
vi.mock("@/lib/safe-download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-download")>();
  return {
    ...actual,
    openSafeStream: vi.fn(async (url: string) => {
      const filename = fixtureRoutes.get(url);
      if (!filename) throw new Error(`unit/merge-videos-adapter.test.ts: no fixture registered for ${url}`);
      return Readable.from(fixtureBytes.get(filename)!);
    }),
  };
});

// Track every execFile invocation (file + args) made anywhere in this test
// run, real ffmpeg calls included — used by the "no ffmpeg process spawned"
// assertion (case 5) to prove a validation failure short-circuits before any
// normalise/merge encode is attempted.
const execFileCalls: { file: string; args: string[] }[] = [];
const realExecFileAsync = promisify(execFile);
async function trackedExecFileAsync(file: string, args: string[], options?: Parameters<typeof realExecFileAsync>[2]) {
  execFileCalls.push({ file, args });
  return realExecFileAsync(file, args, options as never);
}

const FIXTURES_BASE_URL = "https://fixtures.merge-videos.test";

let fixturesDir: string;
const fixtureBytes = new Map<string, Buffer>();
const fixtureDuration = new Map<string, number>();

async function generateFixture(
  destPath: string,
  opts: { width: number; height: number; fps: number; duration: number; hasAudio: boolean; color: string },
) {
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${opts.color}:size=${opts.width}x${opts.height}:rate=${opts.fps}:duration=${opts.duration}`,
  ];
  if (opts.hasAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${opts.duration}`);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (opts.hasAudio) args.push("-c:a", "aac", "-shortest");
  args.push(destPath);
  await trackedExecFileAsync("ffmpeg", args);
}

async function ffprobeDuration(path: string): Promise<number> {
  const { stdout } = await trackedExecFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    path,
  ]);
  return Number(JSON.parse(stdout).format.duration);
}

async function ffprobeHasAudio(path: string): Promise<boolean> {
  const { stdout } = await trackedExecFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    path,
  ]);
  const streams = JSON.parse(stdout).streams as { codec_type: string }[];
  return streams.some((s) => s.codec_type === "audio");
}

function serveFixture(routePath: string, filename: string) {
  fixtureRoutes.set(`${FIXTURES_BASE_URL}/${routePath}`, filename);
}

function ctx(workDir: string) {
  return {
    toolInvocationId: "ti_1",
    agentRunId: "ar_1",
    ownerId: "user_1",
    workDir,
    signal: new AbortController().signal,
  };
}

let workDirs: string[] = [];
async function freshWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "merge-videos-test-"));
  workDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  fixturesDir = await mkdtemp(join(tmpdir(), "merge-videos-fixtures-"));

  // clip-a: 64x64 @ 24fps, 2s, with audio.
  await generateFixture(join(fixturesDir, "clip-a.mp4"), {
    width: 64,
    height: 64,
    fps: 24,
    duration: 2,
    hasAudio: true,
    color: "red",
  });
  // clip-b: mismatched resolution/fps, 2s, with audio.
  await generateFixture(join(fixturesDir, "clip-b.mp4"), {
    width: 96,
    height: 54,
    fps: 30,
    duration: 2,
    hasAudio: true,
    color: "blue",
  });
  // clip-c: 64x64 @ 24fps, 2s, with audio.
  await generateFixture(join(fixturesDir, "clip-c.mp4"), {
    width: 64,
    height: 64,
    fps: 24,
    duration: 2,
    hasAudio: true,
    color: "green",
  });
  // clip-no-audio: 64x64 @ 24fps, 1.5s, video only.
  await generateFixture(join(fixturesDir, "clip-no-audio.mp4"), {
    width: 64,
    height: 64,
    fps: 24,
    duration: 1.5,
    hasAudio: false,
    color: "yellow",
  });
  // clip-short: 64x64 @ 24fps, 0.5s, with audio — shorter than any
  // transitionDurationSeconds tested against it.
  await generateFixture(join(fixturesDir, "clip-short.mp4"), {
    width: 64,
    height: 64,
    fps: 24,
    duration: 0.5,
    hasAudio: true,
    color: "white",
  });

  for (const name of ["clip-a.mp4", "clip-b.mp4", "clip-c.mp4", "clip-no-audio.mp4", "clip-short.mp4"]) {
    fixtureBytes.set(name, await readFile(join(fixturesDir, name)));
    // lavfi's own `duration=N` request doesn't always land on exactly N
    // seconds once frame-quantized (observed ~2.0417s for a "duration=2"
    // request at 24fps) — probe the real generated duration rather than
    // assuming the requested one, so expected-duration math below is
    // computed against ground truth, not a rounded intent.
    fixtureDuration.set(name, await ffprobeDuration(join(fixturesDir, name)));
  }

  serveFixture("clip-a.mp4", "clip-a.mp4");
  serveFixture("clip-b.mp4", "clip-b.mp4");
  serveFixture("clip-c.mp4", "clip-c.mp4");
  serveFixture("clip-no-audio.mp4", "clip-no-audio.mp4");
  serveFixture("clip-short.mp4", "clip-short.mp4");
}, 60_000);

beforeEach(() => {
  execFileCalls.length = 0;
});

afterAll(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
  await Promise.all(workDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const url = (name: string) => `${FIXTURES_BASE_URL}/${name}`;

describe("mergeVideosTool.execute — transitions and duration math", () => {
  it("case 1: 2 clips + fade — output duration ≈ sum − 1×d, sub-frame tolerance", async () => {
    const workDir = await freshWorkDir();
    const d = 0.5;
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-a.mp4"), url("clip-c.mp4")], transition: "fade", transitionDurationSeconds: d },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    const expected = fixtureDuration.get("clip-a.mp4")! + fixtureDuration.get("clip-c.mp4")! - 1 * d;
    // Sub-frame tolerance: within one 24fps frame interval, allowing a
    // little slack for the normalise pass's own re-encode rounding.
    const tolerance = 1.5 * (1 / 24);
    expect(Math.abs(outDuration - expected)).toBeLessThan(tolerance);
  }, 30_000);

  it("case 2: 3 clips + dissolve — output duration ≈ sum − 2×d (chained offsets)", async () => {
    const workDir = await freshWorkDir();
    const d = 0.5;
    const result = await mergeVideosTool.execute(
      {
        video_urls: [url("clip-a.mp4"), url("clip-b.mp4"), url("clip-c.mp4")],
        transition: "dissolve",
        transitionDurationSeconds: d,
      },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    const expected =
      fixtureDuration.get("clip-a.mp4")! +
      fixtureDuration.get("clip-b.mp4")! +
      fixtureDuration.get("clip-c.mp4")! -
      2 * d;
    // A 3-clip chain re-encodes each input once in the normalise pass (one
    // of which also does an fps conversion, 30→24) before the merge encode
    // itself, so a little more rounding slack than the 2-clip case.
    const tolerance = 2.5 * (1 / 24);
    expect(Math.abs(outDuration - expected)).toBeLessThan(tolerance);
  }, 30_000);

  it("case 3: mismatched resolution/FPS across inputs merges cleanly through the normalise pass", async () => {
    const workDir = await freshWorkDir();
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-a.mp4"), url("clip-b.mp4")], transition: "none" },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    expect(outDuration).toBeGreaterThan(3.9); // ~4s, no crash / no truncation
  }, 30_000);

  it("case 4: a clip with no audio track merges via fade without a fabricated crossfade artifact", async () => {
    const workDir = await freshWorkDir();
    const d = 0.5;
    const result = await mergeVideosTool.execute(
      {
        video_urls: [url("clip-no-audio.mp4"), url("clip-a.mp4")],
        transition: "fade",
        transitionDurationSeconds: d,
      },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    const expected = fixtureDuration.get("clip-no-audio.mp4")! + fixtureDuration.get("clip-a.mp4")! - d;
    const tolerance = 1.5 * (1 / 24);
    expect(Math.abs(outDuration - expected)).toBeLessThan(tolerance);
    // Output still carries an audio track (real audio silent-joined with
    // the anullsrc leg, then trimmed to the video's own total duration —
    // see the adapter's final atrim — so it never runs longer than video),
    // even though the boundary never used acrossfade.
    expect(await ffprobeHasAudio(artifact.path)).toBe(true);
  }, 30_000);

  it("case 5: a clip shorter than the requested transition duration fails validation, naming the pair, before any ffmpeg merge runs", async () => {
    const workDir = await freshWorkDir();
    let caught: unknown;
    try {
      await mergeVideosTool.execute(
        {
          video_urls: [url("clip-short.mp4"), url("clip-a.mp4")],
          transition: "fade",
          transitionDurationSeconds: 0.6, // clip-short is only 0.5s
        },
        ctx(workDir),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MergeVideosValidationError);
    expect((caught as Error).message).toMatch(/clip 0.*clip 1/);

    // No normalise or merge encode ever ran — every recorded execFile call
    // was ffprobe (duration probing) only, never an actual encode.
    const encodeCalls = execFileCalls.filter(
      (c) => c.args.includes("-c:v") || c.args.includes("-filter_complex"),
    );
    expect(encodeCalls).toHaveLength(0);
  }, 15_000);

  it("case 6: transition none — output duration equals the exact sum of inputs, zero overlap", async () => {
    const workDir = await freshWorkDir();
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-a.mp4"), url("clip-c.mp4")], transition: "none" },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    const expected = fixtureDuration.get("clip-a.mp4")! + fixtureDuration.get("clip-c.mp4")!;
    // Concat demuxer -c copy of two AAC streams can shift the reported
    // container duration by a fraction of an AAC frame (1024 samples);
    // still tight, just not frame-exact like the video-only figure.
    expect(Math.abs(outDuration - expected)).toBeLessThan(0.15);
  }, 30_000);

  it("case 6b: transition none — first clip has no audio, second does — output still carries an audio stream", async () => {
    const workDir = await freshWorkDir();
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-no-audio.mp4"), url("clip-a.mp4")], transition: "none" },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    // This is the exact regression scenario: the old concat-demuxer
    // implementation took its output stream layout from input 0 alone, so
    // an audio-less first clip silently produced zero audio streams in the
    // output even though the second clip had real audio.
    expect(await ffprobeHasAudio(artifact.path)).toBe(true);
  }, 30_000);

  it("case 6c: transition none — second clip has no audio, first does — output still carries an audio stream", async () => {
    const workDir = await freshWorkDir();
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-a.mp4"), url("clip-no-audio.mp4")], transition: "none" },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    expect(await ffprobeHasAudio(artifact.path)).toBe(true);
  }, 30_000);

  it("case 6d: transition none with mixed-audio clips — output duration still equals the exact sum of inputs", async () => {
    const workDir = await freshWorkDir();
    const result = await mergeVideosTool.execute(
      { video_urls: [url("clip-no-audio.mp4"), url("clip-a.mp4")], transition: "none" },
      ctx(workDir),
    );
    const artifact = result.artifacts[0];
    if (artifact.kind !== "file") throw new Error("expected file artifact");
    const outDuration = await ffprobeDuration(artifact.path);
    const expected = fixtureDuration.get("clip-no-audio.mp4")! + fixtureDuration.get("clip-a.mp4")!;
    // Same tolerance rationale as case 6: concat filter of AAC streams can
    // shift reported container duration by a fraction of an AAC frame.
    expect(Math.abs(outDuration - expected)).toBeLessThan(0.15);
  }, 30_000);

  it("case 7b: an unsupported transition value at the ffmpeg-capability-check level fails with a typed rejection", async () => {
    const workDir = await freshWorkDir();
    await expect(
      mergeVideosTool.execute(
        // Bypasses the Zod schema deliberately, to exercise the adapter's
        // own defensive guard against a value the schema should never admit.
        { video_urls: [url("clip-a.mp4"), url("clip-c.mp4")], transition: "wipeleft" as never },
        ctx(workDir),
      ),
    ).rejects.toBeInstanceOf(MergeVideosValidationError);
  }, 15_000);
});

describe("MergeVideosInputSchema", () => {
  it("case 7a: rejects an unsupported/malformed transition value", () => {
    const result = MergeVideosInputSchema.safeParse({
      video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"],
      transition: "wipeleft",
    });
    expect(result.success).toBe(false);
  });

  it("case 9: transition none with a supplied transitionDurationSeconds is rejected", () => {
    const result = MergeVideosInputSchema.safeParse({
      video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"],
      transition: "none",
      transitionDurationSeconds: 1,
    });
    expect(result.success).toBe(false);
  });

  it("case 10: transitionDurationSeconds <= 0 is rejected", () => {
    const result = MergeVideosInputSchema.safeParse({
      video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"],
      transition: "fade",
      transitionDurationSeconds: 0,
    });
    expect(result.success).toBe(false);

    const negative = MergeVideosInputSchema.safeParse({
      video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"],
      transition: "fade",
      transitionDurationSeconds: -1,
    });
    expect(negative.success).toBe(false);
  });

  it("case 11: the clip-count cap (2-12) is enforced by the schema", () => {
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/${i}.mp4`);

    expect(MergeVideosInputSchema.safeParse({ video_urls: urls(1) }).success).toBe(false);
    expect(MergeVideosInputSchema.safeParse({ video_urls: urls(2) }).success).toBe(true);
    expect(MergeVideosInputSchema.safeParse({ video_urls: urls(12) }).success).toBe(true);
    expect(MergeVideosInputSchema.safeParse({ video_urls: urls(13) }).success).toBe(false);
  });

  it("accepts a valid fade input with an explicit transitionDurationSeconds", () => {
    const result = MergeVideosInputSchema.safeParse({
      video_urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"],
      transition: "fade",
      transitionDurationSeconds: 0.75,
    });
    expect(result.success).toBe(true);
  });
});

describe("mergeVideosTool.estimateCredits", () => {
  it("returns the flat TOOL_CREDIT_ESTIMATE.merge_videos regardless of clip count", () => {
    expect(mergeVideosTool.estimateCredits({} as never)).toBe(TOOL_CREDIT_ESTIMATE.merge_videos);
    expect(TOOL_CREDIT_ESTIMATE.merge_videos).toBe(0.05);
  });
});

// FfmpegExecutionError is exported/typed distinctly from
// MergeVideosValidationError — sanity check the two never collapse into one
// class (both are exercised above, but never asserted against each other).
describe("error taxonomy", () => {
  it("FfmpegExecutionError and MergeVideosValidationError are distinct classes", () => {
    expect(new FfmpegExecutionError("x")).not.toBeInstanceOf(MergeVideosValidationError);
    expect(new MergeVideosValidationError("x")).not.toBeInstanceOf(FfmpegExecutionError);
  });
});
