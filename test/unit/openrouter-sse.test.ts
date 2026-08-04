import { describe, it, expect } from "vitest";
import { parseSseStream, SSE_DONE_SENTINEL } from "@/server/openrouter/sse";

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of parseSseStream(stream)) out.push(line);
  return out;
}

describe("parseSseStream", () => {
  it("yields the JSON payload for a simple data line", async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\n']);
    expect(await collect(body)).toEqual(['{"a":1}']);
  });

  it("skips SSE comment/keepalive lines (': OPENROUTER PROCESSING')", async () => {
    const body = bodyFromChunks([": OPENROUTER PROCESSING\n\n", 'data: {"a":1}\n\n']);
    expect(await collect(body)).toEqual(['{"a":1}']);
  });

  it("skips a comment line interleaved between content chunks", async () => {
    const body = bodyFromChunks([
      'data: {"a":1}\n\n',
      ": OPENROUTER PROCESSING\n\n",
      'data: {"a":2}\n\n',
    ]);
    expect(await collect(body)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("yields [DONE] as a literal payload for the caller to interpret", async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
    const result = await collect(body);
    expect(result[1]).toBe(SSE_DONE_SENTINEL);
  });

  it("reassembles a JSON payload split across two reads", async () => {
    const body = bodyFromChunks(['data: {"a":', '1}\n\n']);
    expect(await collect(body)).toEqual(['{"a":1}']);
  });

  it("tolerates \\r\\n line endings", async () => {
    const body = bodyFromChunks(['data: {"a":1}\r\n\r\n']);
    expect(await collect(body)).toEqual(['{"a":1}']);
  });

  it("flushes a final line with no trailing newline (truncated stream)", async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\n', 'data: {"a":2}']);
    expect(await collect(body)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("returns nothing for an empty stream", async () => {
    const body = bodyFromChunks([]);
    expect(await collect(body)).toEqual([]);
  });

  it("handles multiple data lines within a single chunk", async () => {
    const body = bodyFromChunks(['data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n']);
    expect(await collect(body)).toEqual(['{"a":1}', '{"a":2}', "[DONE]"]);
  });

  it("flushes a dangling incomplete multi-byte UTF-8 sequence at true EOF instead of silently dropping it (hardening pass)", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode('data: {"a":"');
    const euro = encoder.encode("€"); // 3-byte UTF-8 sequence: E2 82 AC
    // Only the first byte of the multi-byte character ever arrives before
    // the stream ends — a genuinely truncated response. Without a final
    // (no-argument) decoder.decode() flush at EOF, TextDecoder holds this
    // byte internally forever and it never reaches `buffer` at all, so the
    // line-flush logic below has nothing to work with — the byte vanishes
    // silently. With the flush, WHATWG TextDecoder emits U+FFFD for the
    // incomplete sequence instead, so it's visibly present, not dropped.
    const truncated = new Uint8Array([...prefix, euro[0]]);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(truncated);
        controller.close();
      },
    });

    const [line] = await collect(body);
    expect(line).toContain("�");
  });
});
