/**
 * Pure SSE line/frame decoder for OpenRouter's chat-completions stream.
 * No OpenRouter-specific JSON parsing here — this module only turns a raw
 * byte stream into the sequence of `data:` payload strings, exactly per the
 * wire format OpenRouter documents (verified against
 * openrouter.ai/docs/api_reference/streaming, S2 implementation plan §E):
 *
 *   - `data: <payload>` lines carry the JSON payload (note the single
 *     space after the colon — every OpenRouter example does `line.slice(6)`).
 *   - `data: [DONE]` is the terminal sentinel — callers see the literal
 *     string "[DONE]" and decide what to do with it (this module does not
 *     special-case it, so it stays reusable for non-OpenRouter SSE too).
 *   - Lines beginning with `:` are comments/keepalives (OpenRouter's is the
 *     literal `: OPENROUTER PROCESSING`) and MUST be skipped before any
 *     JSON.parse attempt — their cadence is undocumented, so nothing here
 *     builds a timeout heuristic on them.
 *   - Blank lines are event separators and are skipped.
 *   - A JSON payload can be split across TCP reads, so bytes are buffered
 *     across `reader.read()` calls, splitting only on `\n`.
 *   - Both `\n` and `\r\n` line endings are tolerated (the wire terminator
 *     is not documented).
 *   - A stream can legitimately end with no trailing newline on the final
 *     line and no `[DONE]` at all (the "truncated" case) — any bytes left
 *     in the buffer at EOF are flushed as one final line.
 */

const DATA_PREFIX = "data:";

function stripLineEnding(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Returns the payload after `data:`/`data: `, or undefined if the line isn't a data line. */
function extractDataPayload(line: string): string | undefined {
  if (!line.startsWith(DATA_PREFIX)) return undefined;
  const rest = line.slice(DATA_PREFIX.length);
  // Exactly one leading space is documented; be lenient and trim any.
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/**
 * Consumes an SSE byte stream and yields each `data:` line's payload string
 * in order. Comment lines, blank lines, and any other non-`data:` line are
 * silently skipped (SSE spec: safe to ignore; OpenRouter's own reference
 * parser does the same).
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let readerDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        readerDone = true;
        // Flush any incomplete multi-byte UTF-8 sequence the decoder is
        // still holding internally — the prior `{ stream: true }` calls
        // never do this on their own, so a character split exactly across
        // the last two reads would otherwise be silently dropped/mangled
        // (hardening pass).
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = stripLineEnding(rawLine);

        if (line.length === 0) continue; // event separator
        if (line.startsWith(":")) continue; // comment/keepalive

        const payload = extractDataPayload(line);
        if (payload !== undefined) yield payload;
      }
    }

    // Flush a final line with no trailing newline (truncated-stream case).
    const finalLine = stripLineEnding(buffer);
    if (finalLine.length > 0 && !finalLine.startsWith(":")) {
      const payload = extractDataPayload(finalLine);
      if (payload !== undefined) yield payload;
    }
  } finally {
    // An early exit (caller stops consuming the generator before natural
    // EOF — a mid-stream `error` chunk, or the generator's own `return()`
    // from a `for await` `break`/`return`) must not leave the upstream
    // connection open. `releaseLock()` alone only frees the reader for a
    // new lock — it does not close the underlying response body/socket.
    // Cancellation is requested but deliberately NOT awaited: some stream
    // implementations (observed with mocked/intercepted fetch responses in
    // tests, and not guaranteed otherwise per the Streams spec) never
    // settle `cancel()`'s promise, which would hang generator teardown
    // indefinitely — worse than the leak this is meant to fix.
    if (!readerDone) {
      reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

export const SSE_DONE_SENTINEL = "[DONE]";
