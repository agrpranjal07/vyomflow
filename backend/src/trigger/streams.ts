import { streams } from "@trigger.dev/sdk";
import type { TurnStreamPart } from "@/contracts/runs";

/**
 * Verified against the installed @trigger.dev/sdk 4.5.11: `streams.define`
 * is single-argument (`{ id }`) — the two-arg schema form seen in some
 * docs/blog posts does not exist in this version. The frontend consumes
 * this same key string via the string-key `useRealtimeStream(runId, key,
 * options)` overload (the typed stream object itself cannot cross the
 * repo boundary), so the key is exported as a plain constant, not just the
 * defined-stream object.
 */
export const ASSISTANT_STREAM_KEY = "assistant";

export const assistantStream = streams.define<TurnStreamPart>({ id: ASSISTANT_STREAM_KEY });
