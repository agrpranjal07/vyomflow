import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_DELIVERY_ATTEMPT_HEADER,
} from "@/server/webhooks/signing";

describe("signWebhookPayload", () => {
  it("produces a sha384= prefixed signature over `${timestamp}.${rawBody}`", () => {
    const rawBody = JSON.stringify({ runId: "run_1", status: "completed" });
    const timestamp = "1700000000000";
    const signature = signWebhookPayload(rawBody, timestamp, "test-secret");

    expect(signature.startsWith("sha384=")).toBe(true);
    const expectedHex = createHmac("sha384", "test-secret").update(`${timestamp}.${rawBody}`).digest("hex");
    expect(signature).toBe(`sha384=${expectedHex}`);
  });

  it("is deterministic — the same inputs always produce the same signature", () => {
    const rawBody = JSON.stringify({ a: 1 });
    const first = signWebhookPayload(rawBody, "123", "secret");
    const second = signWebhookPayload(rawBody, "123", "secret");
    expect(first).toBe(second);
  });

  it("changes when the raw body, timestamp, or secret changes", () => {
    const base = signWebhookPayload('{"a":1}', "123", "secret");
    expect(signWebhookPayload('{"a":2}', "123", "secret")).not.toBe(base);
    expect(signWebhookPayload('{"a":1}', "456", "secret")).not.toBe(base);
    expect(signWebhookPayload('{"a":1}', "123", "other-secret")).not.toBe(base);
  });

  it("never re-serializes — the exact rawBody string passed in is what gets signed, not a re-stringified equivalent", () => {
    // Two byte-different-but-semantically-equal JSON strings must sign
    // differently — proves the function signs the literal string, never an
    // object it re-serializes itself.
    const compact = '{"a":1,"b":2}';
    const spaced = '{"a": 1, "b": 2}';
    expect(signWebhookPayload(compact, "1", "s")).not.toBe(signWebhookPayload(spaced, "1", "s"));
  });
});

describe("verifyWebhookSignature — round trip", () => {
  it("verifies a signature produced by signWebhookPayload with the same inputs", () => {
    const rawBody = JSON.stringify({ toolInvocationId: "ti_1", name: "crop_image" });
    const timestamp = Date.now().toString();
    const signature = signWebhookPayload(rawBody, timestamp, "receiver-secret");
    expect(verifyWebhookSignature(rawBody, timestamp, "receiver-secret", signature)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const rawBody = JSON.stringify({ a: 1 });
    const timestamp = "1700000000000";
    const signature = signWebhookPayload(rawBody, timestamp, "secret-a");
    expect(verifyWebhookSignature(rawBody, timestamp, "secret-b", signature)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const timestamp = "1700000000000";
    const signature = signWebhookPayload(JSON.stringify({ a: 1 }), timestamp, "secret");
    expect(verifyWebhookSignature(JSON.stringify({ a: 2 }), timestamp, "secret", signature)).toBe(false);
  });

  it("rejects a malformed/mismatched-length signature without throwing", () => {
    expect(verifyWebhookSignature("{}", "1", "secret", "sha384=not-hex")).toBe(false);
    expect(verifyWebhookSignature("{}", "1", "secret", "")).toBe(false);
  });
});

describe("header name constants", () => {
  it("match the plan's documented wire names exactly", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-Vyomflow-Signature");
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe("X-Vyomflow-Timestamp");
    expect(WEBHOOK_EVENT_ID_HEADER).toBe("X-Vyomflow-Event-Id");
    expect(WEBHOOK_DELIVERY_ATTEMPT_HEADER).toBe("X-Vyomflow-Delivery-Attempt");
  });
});
