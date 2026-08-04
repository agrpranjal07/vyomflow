import { describe, it, expect } from "vitest";
import { classifyOpenRouterError, parseOpenRouterErrorBody, OpenRouterErrorPayloadSchema } from "@/server/openrouter/errors";

describe("OpenRouterErrorPayloadSchema", () => {
  it("accepts a numeric error.code", () => {
    expect(OpenRouterErrorPayloadSchema.safeParse({ code: 429, message: "Rate limit exceeded" }).success).toBe(true);
  });

  it("accepts a string error.code", () => {
    expect(
      OpenRouterErrorPayloadSchema.safeParse({ code: "server_error", message: "Provider disconnected" }).success,
    ).toBe(true);
  });

  it("accepts an absent metadata field", () => {
    const result = OpenRouterErrorPayloadSchema.safeParse({
      code: 402,
      message: "Your account or API key has insufficient credits.",
    });
    expect(result.success).toBe(true);
  });
});

describe("classifyOpenRouterError", () => {
  it("marks rate_limit_exceeded as never-retryable", () => {
    const result = classifyOpenRouterError({
      code: 429,
      message: "Rate limit exceeded",
      metadata: { error_type: "rate_limit_exceeded" },
    });
    expect(result.retryable).toBe(false);
    expect(result.errorType).toBe("rate_limit_exceeded");
  });

  it("marks provider_overloaded as retryable", () => {
    const result = classifyOpenRouterError({
      code: 502,
      message: "Provider overloaded",
      metadata: { error_type: "provider_overloaded" },
    });
    expect(result.retryable).toBe(true);
  });

  it("falls back to error.code when metadata is absent", () => {
    const result = classifyOpenRouterError({ code: 402, message: "Insufficient credits." });
    expect(result.errorType).toBe("402");
  });

  // S4 bug fix: a raw HTTP status is now normalized into the same symbolic
  // taxonomy the retry policy is keyed on, instead of being passed through as
  // a bare "503" that matched neither the retryable nor the never-retry set.
  it("normalizes httpStatus into the taxonomy when the code carries no taxonomy signal", () => {
    const result = classifyOpenRouterError({ code: "unknown", message: "x" }, 503);
    expect(result.errorType).toBe("provider_unavailable");
    expect(result.retryable).toBe(true);
  });

  it("falls through past an empty-string code to the normalized httpStatus", () => {
    const result = classifyOpenRouterError({ code: "", message: "x" }, 503);
    expect(result.errorType).toBe("provider_unavailable");
    expect(result.retryable).toBe(true);
  });

  it("passes an unmapped httpStatus through as its bare string", () => {
    const result = classifyOpenRouterError({ code: "", message: "x" }, 418);
    expect(result.errorType).toBe("418");
    expect(result.retryable).toBe(false);
  });

  // A `code` that is itself a taxonomy value is more specific than the HTTP
  // status wrapping it, so it must win — otherwise a 429 carrying code
  // "provider_overloaded" would flip retryable -> never-retry, and a 500
  // carrying "content_policy_violation" would flip never-retry -> retryable.
  it("prefers a taxonomy-valued code over the HTTP status wrapping it", () => {
    const overloaded = classifyOpenRouterError({ code: "provider_overloaded", message: "x" }, 429);
    expect(overloaded.errorType).toBe("provider_overloaded");
    expect(overloaded.retryable).toBe(true);

    const policy = classifyOpenRouterError({ code: "content_policy_violation", message: "x" }, 500);
    expect(policy.errorType).toBe("content_policy_violation");
    expect(policy.retryable).toBe(false);
  });

  it("falls through to the literal 'unknown' when code is empty and no httpStatus was given", () => {
    const result = classifyOpenRouterError({ code: "", message: "x" });
    expect(result.errorType).toBe("unknown");
  });

  it("produces a user-safe message that never echoes the raw provider message", () => {
    const result = classifyOpenRouterError({
      code: 429,
      message: "Rate limit exceeded",
      metadata: { error_type: "rate_limit_exceeded" },
    });
    expect(result.userMessage).not.toContain("undefined");
    expect(result.userMessage.length).toBeGreaterThan(0);
  });
});

describe("parseOpenRouterErrorBody", () => {
  it("extracts the error envelope from a well-formed body", () => {
    const parsed = parseOpenRouterErrorBody({ error: { code: 429, message: "Rate limit exceeded" } });
    expect(parsed?.code).toBe(429);
  });

  it("returns undefined for a body with no error field", () => {
    expect(parseOpenRouterErrorBody({ foo: "bar" })).toBeUndefined();
  });

  it("returns undefined for a non-object body", () => {
    expect(parseOpenRouterErrorBody("not json")).toBeUndefined();
    expect(parseOpenRouterErrorBody(undefined)).toBeUndefined();
  });
});
