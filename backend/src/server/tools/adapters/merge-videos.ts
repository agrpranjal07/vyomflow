/**
 * merge_videos adapter — media-tool arm (ffmpeg, in-process). Implements
 * MediaToolFields.execute directly. This is the most duration-math-sensitive
 * of the three adapters: offsets for a 3+ clip xfade/acrossfade chain must
 * be computed cumulatively or the transitions visibly desync.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { join } from "node:path";
import { MERGE_VIDEOS_TOOL_NAME, MergeVideosInputSchema, type MergeVideosInput } from "@/contracts/tools";
import { TOOL_CREDIT_ESTIMATE } from "@/lib/config";
import { openSafeStream, SafeDownloadError, UnsafeUrlError } from "@/lib/safe-download";
import type { ToolDefinition } from "@/server/tools/registry";

const execFileAsync = promisify(execFile);

/**
 * Never surface raw ffmpeg/ffprobe stderr to a caller — this carries a short
 * internal diagnostic only. Phase 3 (`classifyMediaToolError`, per the
 * migration plan §B2) builds the real user-safe classifier; this adapter
 * only needs a typed error to throw, same pattern crop_image's
 * CropExtractError uses.
 */
export class FfmpegExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegExecutionError";
  }
}

/**
 * Typed, structurally distinct from FfmpegExecutionError: this fires before
 * any ffmpeg process is spawned (the execute()-side half of the schema's
 * deferred transitionDurationSeconds upper-bound check — see
 * contracts/tools.ts's MergeVideosInputSchema comment). Always names the
 * specific offending clip pair.
 */
export class MergeVideosValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeVideosValidationError";
  }
}

// --- Resource guards (judgment calls, documented per adapter convention) ---

/** Per-file download cap. */
const MAX_MERGE_INPUT_BYTES = 200 * 1024 * 1024;
/** Total download cap across all inputs. */
const MAX_MERGE_TOTAL_BYTES = 800 * 1024 * 1024;
/**
 * Total post-probe duration cap across all inputs, before spawning the merge.
 * Phase 6 review finding: this must stay well inside MERGE_VIDEOS_BUDGET_MS
 * (config.ts, 300s) — the normalise pass re-encodes every input regardless
 * of transition mode, and libx264 at `-preset veryfast` on the task's
 * `small-2x` machine cannot reliably re-encode anywhere near the previous
 * 20-minute cap's worth of input inside that budget. 3 minutes total leaves
 * generous headroom for download + two encode passes + the final merge.
 */
const MAX_MERGE_TOTAL_DURATION_SECONDS = 3 * 60;

/** Default transitionDurationSeconds when the field is omitted (contracts/tools.ts's comment). */
const DEFAULT_TRANSITION_DURATION_SECONDS = 1.0;

const XFADE_TRANSITION_NAMES = {
  fade: "fade",
  dissolve: "dissolve",
} as const;

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}
function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

interface ProbedInput {
  path: string;
  duration: number;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}
interface FfprobeFormat {
  duration?: string;
}
interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

function parseFrameRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

async function downloadToWorkDir(
  url: string,
  destPath: string,
  signal: AbortSignal,
  remainingTotalBudget: { bytes: number },
): Promise<number> {
  // openSafeStream resolves+validates the destination (scheme allowlist,
  // DNS-resolved-address privacy check, pinned connection, re-validated
  // redirects) before any bytes move — see lib/safe-download.ts.
  let response: import("node:http").IncomingMessage;
  try {
    response = await openSafeStream(url, { signal });
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof SafeDownloadError) {
      throw new FfmpegExecutionError(`merge_videos: ${err.message}`);
    }
    throw new FfmpegExecutionError(`merge_videos: failed to fetch ${url}: ${(err as Error).message}`);
  }

  // A declared content-length is a hint only — never trusted alone. Bytes
  // are counted as they actually arrive and the stream is aborted mid-flight
  // if either cap is exceeded, since a lying/absent header must not let an
  // oversized/unbounded body through.
  let received = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length;
      if (received > MAX_MERGE_INPUT_BYTES) {
        callback(
          new FfmpegExecutionError(
            `merge_videos: source ${url} exceeded MAX_MERGE_INPUT_BYTES (${MAX_MERGE_INPUT_BYTES}) while downloading`,
          ),
        );
        return;
      }
      if (received > remainingTotalBudget.bytes) {
        callback(
          new FfmpegExecutionError(
            `merge_videos: total downloaded size exceeded MAX_MERGE_TOTAL_BYTES (${MAX_MERGE_TOTAL_BYTES})`,
          ),
        );
        return;
      }
      callback(undefined, chunk);
    },
  });

  try {
    await pipeline(response, capped, createWriteStream(destPath));
  } catch (err) {
    if (err instanceof FfmpegExecutionError) throw err;
    throw new FfmpegExecutionError(`merge_videos: streaming download of ${url} failed: ${(err as Error).message}`);
  }

  remainingTotalBudget.bytes -= received;
  return received;
}

async function ffprobeFile(path: string, signal: AbortSignal): Promise<ProbedInput> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobeBin(),
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
      { signal, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new FfmpegExecutionError(`merge_videos: ffprobe failed for ${path}: ${(err as Error).message}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    throw new FfmpegExecutionError(`merge_videos: could not parse ffprobe output for ${path}: ${(err as Error).message}`);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? videoStream?.duration ?? NaN);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegExecutionError(`merge_videos: could not determine a valid duration for ${path}`);
  }
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new FfmpegExecutionError(`merge_videos: ${path} has no usable video stream`);
  }
  const fps = parseFrameRate(videoStream.avg_frame_rate) ?? parseFrameRate(videoStream.r_frame_rate) ?? 30;

  return {
    path,
    duration,
    hasAudio: Boolean(audioStream),
    width: videoStream.width,
    height: videoStream.height,
    fps,
  };
}

/**
 * Verifies ffmpeg's own build actually registers xfade/acrossfade before any
 * merge ffmpeg process is spawned — defensive against a build lacking them
 * entirely (in normal operation this can't fire, since the schema only
 * permits "none"/"fade"/"dissolve").
 */
async function assertXfadeSupport(signal: AbortSignal): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync(ffmpegBin(), ["-hide_banner", "-filters"], { signal, maxBuffer: 1024 * 1024 });
    stdout = result.stdout;
  } catch (err) {
    throw new FfmpegExecutionError(`merge_videos: could not query ffmpeg -filters: ${(err as Error).message}`);
  }
  if (!/\bxfade\b/.test(stdout) || !/\bacrossfade\b/.test(stdout)) {
    throw new FfmpegExecutionError("merge_videos: this ffmpeg build does not support xfade/acrossfade");
  }
}

/**
 * Shared by both the "none" (concat filter) and xfade/dissolve merge paths:
 * builds the ffmpeg -i input args for every normalised clip plus one
 * anullsrc=r=48000:cl=stereo lavfi input per audio-less clip, and returns a
 * label resolver so a filter graph can reference "this clip's audio" without
 * caring whether it's real or silent. Matches the normalise pass's pinned
 * -ar 48000 -ac 2 so every real audio leg and every anullsrc leg share one
 * sample rate/channel layout, which concat/acrossfade both require.
 */
function buildAudioLegs(normalisedPaths: string[], normalised: ProbedInput[]): {
  inputArgs: string[];
  audioLabelFor: (i: number) => string;
} {
  const inputArgs: string[] = [];
  for (let i = 0; i < normalisedPaths.length; i++) {
    inputArgs.push("-i", normalisedPaths[i]);
  }
  const anullsrcInputIndexForClip = new Map<number, number>();
  let nextInputIndex = normalisedPaths.length;
  for (let i = 0; i < normalised.length; i++) {
    if (!normalised[i].hasAudio) {
      inputArgs.push("-f", "lavfi", "-t", String(normalised[i].duration), "-i", "anullsrc=r=48000:cl=stereo");
      anullsrcInputIndexForClip.set(i, nextInputIndex);
      nextInputIndex += 1;
    }
  }
  const audioLabelFor = (i: number) =>
    normalised[i].hasAudio ? `${i}:a` : `${anullsrcInputIndexForClip.get(i)}:a`;
  return { inputArgs, audioLabelFor };
}

export const mergeVideosTool: ToolDefinition<MergeVideosInput> = {
  name: MERGE_VIDEOS_TOOL_NAME,
  description:
    "Merge 2-12 videos, in the given order, into a single video. transition may be " +
    "none (default), fade, or dissolve. transitionDurationSeconds (default 1.0) sets " +
    "the crossfade length when transition is fade or dissolve.",
  inputSchema: MergeVideosInputSchema,
  engine: "ffmpeg",

  estimateCredits: () => TOOL_CREDIT_ESTIMATE.merge_videos,

  async execute(input, ctx) {
    const transition = input.transition ?? "none";
    const transitionDuration =
      transition === "none" ? 0 : (input.transitionDurationSeconds ?? DEFAULT_TRANSITION_DURATION_SECONDS);

    // Defensive: the Zod schema only ever admits "none"/"fade"/"dissolve",
    // so this branch should never fire in normal operation — but a value
    // that bypasses the schema (e.g. a stale persisted input, or a direct
    // execute() caller in a test) must fail with a typed, named rejection
    // rather than propagating an `undefined` transition name into ffmpeg's
    // own -filter_complex string.
    if (transition !== "none" && !(transition in XFADE_TRANSITION_NAMES)) {
      throw new MergeVideosValidationError(`merge_videos: unsupported transition value: ${transition}`);
    }

    if (transition !== "none") {
      await assertXfadeSupport(ctx.signal);
    }

    // 1. Download every input into ctx.workDir, streaming (never buffering
    // a whole video in memory) with per-file and total-size caps enforced
    // while bytes actually arrive.
    const remainingTotalBudget = { bytes: MAX_MERGE_TOTAL_BYTES };
    const localPaths: string[] = [];
    for (let i = 0; i < input.video_urls.length; i++) {
      const destPath = join(ctx.workDir, `input-${i}.mp4`);
      await downloadToWorkDir(input.video_urls[i], destPath, ctx.signal, remainingTotalBudget);
      localPaths.push(destPath);
    }

    // 2. ffprobe every downloaded file.
    const probed: ProbedInput[] = [];
    for (const path of localPaths) {
      probed.push(await ffprobeFile(path, ctx.signal));
    }

    const totalRawDuration = probed.reduce((sum, p) => sum + p.duration, 0);
    if (totalRawDuration > MAX_MERGE_TOTAL_DURATION_SECONDS) {
      throw new MergeVideosValidationError(
        `merge_videos: total input duration ${totalRawDuration.toFixed(2)}s exceeds ` +
          `MAX_MERGE_TOTAL_DURATION_SECONDS (${MAX_MERGE_TOTAL_DURATION_SECONDS})`,
      );
    }

    // Schema-deferred upper-bound check: transitionDurationSeconds must be
    // less than the shorter of every adjacent pair's real (post-normalise —
    // normalise doesn't change duration, only resolution/fps/SAR) probed
    // duration. Runs before any merge ffmpeg process is spawned, and names
    // the specific offending pair (see contracts/tools.ts's comment).
    if (transition !== "none") {
      for (let i = 0; i < probed.length - 1; i++) {
        const usable = Math.min(probed[i].duration, probed[i + 1].duration);
        if (!(transitionDuration < usable)) {
          throw new MergeVideosValidationError(
            `merge_videos: transitionDurationSeconds (${transitionDuration}) must be less than the shorter ` +
              `duration of clip ${i} (${probed[i].duration.toFixed(2)}s) and clip ${i + 1} (${probed[i + 1].duration.toFixed(2)}s)`,
          );
        }
      }
    }

    // 3. Per-input normalise pass — target resolution/fps taken from the
    // FIRST clip's own probed values (a simple, deterministic choice, not a
    // "best common denominator" algorithm — judgment call, see report).
    const targetWidth = probed[0].width;
    const targetHeight = probed[0].height;
    const targetFps = probed[0].fps;
    const normalisedPaths: string[] = [];
    const scaleFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:-1:-1,setsar=1,fps=${targetFps}`;
    for (let i = 0; i < probed.length; i++) {
      const outPath = join(ctx.workDir, `norm-${i}.mp4`);
      const args = [
        "-y",
        "-i",
        probed[i].path,
        "-vf",
        scaleFilter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        // -ar/-ac pinned to match anullsrc=r=48000:cl=stereo exactly: the
        // concat filter and acrossfade both require identical sample
        // rate/channel layout across every audio leg they join, real or
        // silent.
        ...(probed[i].hasAudio ? ["-c:a", "aac", "-ar", "48000", "-ac", "2"] : ["-an"]),
        outPath,
      ];
      try {
        await execFileAsync(ffmpegBin(), args, { signal: ctx.signal, maxBuffer: 1024 * 1024 });
      } catch (err) {
        throw new FfmpegExecutionError(`merge_videos: normalise pass failed for clip ${i}: ${(err as Error).message}`);
      }
      normalisedPaths.push(outPath);
    }

    // Re-probe normalised outputs for their exact post-normalise durations
    // (encoding can shift duration by sub-frame amounts) — both the offset
    // math and the final duration assertions must rest on these, not the
    // raw pre-normalise probe.
    const normalised: ProbedInput[] = [];
    for (const path of normalisedPaths) {
      normalised.push(await ffprobeFile(path, ctx.signal));
    }

    // Phase 6 review finding: the earlier transitionDurationSeconds check
    // (above) validates against the PRE-normalise probed durations, but the
    // offset math below runs against the POST-normalise re-probe — and
    // normalising (scale/pad/fps) can shift a duration by sub-frame amounts.
    // A clip that legitimately passed the first check could re-probe just
    // under transitionDuration, producing a negative/invalid xfade offset
    // for input the validation already told the caller was legal. Re-run
    // the identical check against the values the offset math actually uses.
    if (transition !== "none") {
      for (let i = 0; i < normalised.length - 1; i++) {
        const usable = Math.min(normalised[i].duration, normalised[i + 1].duration);
        if (!(transitionDuration < usable)) {
          throw new MergeVideosValidationError(
            `merge_videos: transitionDurationSeconds (${transitionDuration}) must be less than the shorter ` +
              `post-normalise duration of clip ${i} (${normalised[i].duration.toFixed(2)}s) and clip ${i + 1} (${normalised[i + 1].duration.toFixed(2)}s)`,
          );
        }
      }
    }

    const outPath = join(ctx.workDir, "out.mp4");

    if (transition === "none") {
      // Concat *filter* graph, not the concat demuxer: the demuxer's
      // -c copy stream layout is taken from the FIRST input file only, so
      // mixing an audio-less clip with an audio-bearing clip through it
      // silently drops audio from the whole output whenever the first clip
      // has none. The filter graph gives every clip an explicit audio leg
      // (real or anullsrc, via buildAudioLegs — same machinery the
      // xfade/dissolve path uses) so output audio layout is always the
      // uniform stereo AAC track the concat=a=1 node produces. Still zero
      // overlap / exact sum(durations) — only how the concat is executed
      // has changed, not "none"'s semantics.
      const { inputArgs, audioLabelFor } = buildAudioLegs(normalisedPaths, normalised);
      const concatInputs = normalised.map((_, i) => `[${i}:v][${audioLabelFor(i)}]`).join("");
      const filterComplex = `${concatInputs}concat=n=${normalised.length}:v=1:a=1[vout][aout]`;
      const args = [
        "-y",
        ...inputArgs,
        "-filter_complex",
        filterComplex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        outPath,
      ];
      try {
        await execFileAsync(ffmpegBin(), args, { signal: ctx.signal, maxBuffer: 1024 * 1024 });
      } catch (err) {
        throw new FfmpegExecutionError(`merge_videos: concat merge failed: ${(err as Error).message}`);
      }
    } else {
      const xfadeName = XFADE_TRANSITION_NAMES[transition];

      // Cumulative offset loop — the offset for the transition between clip
      // i and clip i+1 is (cumulative normalised duration through clip i,
      // inclusive) minus ((i+1) * transitionDuration): xfade's own `offset`
      // is "time within the *first* input of this node when the transition
      // should start" (ffmpeg wiki), i.e. duration_of_first_input − d for a
      // single pair — and each PRIOR transition has already folded one more
      // `d` seconds out of the running cumulative timeline feeding this
      // node. Verified against real ffprobe'd output duration for 2- and
      // 3-clip chains during test development — the naive "− i*d" reading
      // of this formula silently mis-times every transition after the
      // first (off by exactly one `d`) even though a single 2-clip case
      // superficially looks correct (xfade clamps a too-late offset to fit,
      // masking the bug there but not once a node's first input is itself
      // an already-composited xfade output). Computed once; used
      // identically for both the video (xfade) and audio (acrossfade)
      // filter chains.
      const offsets: number[] = [];
      let cumulative = 0;
      for (let i = 0; i < normalised.length - 1; i++) {
        cumulative += normalised[i].duration;
        offsets.push(cumulative - (i + 1) * transitionDuration);
      }

      // anullsrc legs for audio-less inputs, appended after the real video
      // inputs so filter-graph input indices stay simple to track — shared
      // with the "none" path via buildAudioLegs.
      const { inputArgs, audioLabelFor } = buildAudioLegs(normalisedPaths, normalised);

      const videoFilterParts: string[] = [];
      let videoLabel = "0:v";
      for (let i = 0; i < normalised.length - 1; i++) {
        const nextLabel = `${i + 1}:v`;
        const outLabel = i === normalised.length - 2 ? "vout" : `vx${i}`;
        videoFilterParts.push(
          `[${videoLabel}][${nextLabel}]xfade=transition=${xfadeName}:duration=${transitionDuration}:offset=${offsets[i]}[${outLabel}]`,
        );
        videoLabel = outLabel;
      }

      const audioFilterParts: string[] = [];
      let audioLabel = audioLabelFor(0);
      for (let i = 0; i < normalised.length - 1; i++) {
        const nextInputAudioLabel = audioLabelFor(i + 1);
        const outLabel = i === normalised.length - 2 ? "araw" : `ax${i}`;
        // A boundary where EITHER side never had a real audio track uses a
        // plain concatenated silent join, never a fabricated crossfade on
        // audio that never existed. Unlike acrossfade, a plain concat does
        // not fold `transitionDuration` out of its own length, so this leg
        // alone would leave the composed audio track `transitionDuration`
        // longer than the video track at this boundary — corrected below by
        // trimming the whole audio chain to the video's own total duration.
        const bothReal = normalised[i].hasAudio && normalised[i + 1].hasAudio;
        if (bothReal) {
          audioFilterParts.push(
            `[${audioLabel}][${nextInputAudioLabel}]acrossfade=d=${transitionDuration}[${outLabel}]`,
          );
        } else {
          audioFilterParts.push(`[${audioLabel}][${nextInputAudioLabel}]concat=n=2:v=0:a=1[${outLabel}]`);
        }
        audioLabel = outLabel;
      }

      // Total output duration per the same offset math verified above:
      // sum(normalised durations) − (n−1)×transitionDuration. Trimming the
      // composed audio chain to this exact length keeps audio/video length
      // matched even across a plain-concat (non-crossfade) boundary — a
      // no-op for an all-real-audio chain (acrossfade already lands here).
      const totalDuration =
        normalised.reduce((sum, p) => sum + p.duration, 0) - (normalised.length - 1) * transitionDuration;
      audioFilterParts.push(`[araw]atrim=0:${totalDuration},asetpts=PTS-STARTPTS[aout]`);

      const filterComplex = [...videoFilterParts, ...audioFilterParts].join(";");
      const args = [
        "-y",
        ...inputArgs,
        "-filter_complex",
        filterComplex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        outPath,
      ];
      try {
        await execFileAsync(ffmpegBin(), args, { signal: ctx.signal, maxBuffer: 1024 * 1024 });
      } catch (err) {
        throw new FfmpegExecutionError(`merge_videos: xfade merge failed: ${(err as Error).message}`);
      }
    }

    return {
      artifacts: [
        {
          kind: "file",
          path: outPath,
          contentType: "video/mp4",
          filename: "merged.mp4",
        },
      ],
    };
  },
};
