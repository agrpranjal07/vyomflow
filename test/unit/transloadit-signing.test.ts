import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signParams, buildAuthBlock, TransloaditConfigError } from "@/server/transloadit/signing";

const ORIGINAL_KEY = process.env.TRANSLOADIT_AUTH_KEY;
const ORIGINAL_SECRET = process.env.TRANSLOADIT_AUTH_SECRET;

beforeEach(() => {
  process.env.TRANSLOADIT_AUTH_KEY = "test_auth_key";
  process.env.TRANSLOADIT_AUTH_SECRET = "test-secret";
});

afterEach(() => {
  process.env.TRANSLOADIT_AUTH_KEY = ORIGINAL_KEY;
  process.env.TRANSLOADIT_AUTH_SECRET = ORIGINAL_SECRET;
});

describe("signParams", () => {
  it("produces a sha384: prefixed signature", () => {
    const { signature } = signParams({ a: 1 });
    expect(signature.startsWith("sha384:")).toBe(true);
  });

  it("signature is a correct HMAC-SHA384 of the exact params string", () => {
    const params = { auth: { key: "k", expires: "2026-01-01T00:00:00.000Z", nonce: "n" }, template_id: "t", fields: { a: "1" } };
    const { params: jsonString, signature } = signParams(params);
    const expected = "sha384:" + createHmac("sha384", "test-secret").update(jsonString).digest("hex");
    expect(signature).toBe(expected);
    // The returned params string must be exactly what JSON.stringify would
    // produce for the same object — never re-serialized separately.
    expect(jsonString).toBe(JSON.stringify(params));
  });

  it("throws a clearly-named error when TRANSLOADIT_AUTH_SECRET is unset, and the message never contains the secret", () => {
    delete process.env.TRANSLOADIT_AUTH_SECRET;
    let caught: unknown;
    try {
      signParams({ a: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransloaditConfigError);
    expect((caught as Error).message).not.toContain("test-secret");
  });
});

describe("buildAuthBlock", () => {
  it("expires is valid ISO 8601 and in the future", () => {
    const before = Date.now();
    const { expires } = buildAuthBlock(60_000);
    const expiresMs = Date.parse(expires);
    expect(Number.isNaN(expiresMs)).toBe(false);
    expect(expiresMs).toBeGreaterThan(before);
  });

  it("nonce differs across two consecutive calls", () => {
    const first = buildAuthBlock(60_000);
    const second = buildAuthBlock(60_000);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("throws a clearly-named error when TRANSLOADIT_AUTH_KEY is unset", () => {
    delete process.env.TRANSLOADIT_AUTH_KEY;
    expect(() => buildAuthBlock(60_000)).toThrow(TransloaditConfigError);
  });
});
