import { describe, it, expect } from "vitest";
import { isInsufficientCredits } from "@/lib/credit-errors";
import { ApiError } from "@/lib/api-client";

describe("isInsufficientCredits", () => {
  it("is true for a 402 ApiError regardless of code", () => {
    expect(isInsufficientCredits(new ApiError(402, "SOMETHING_ELSE", "nope"))).toBe(true);
  });

  it("is true for an ApiError carrying code INSUFFICIENT_CREDITS regardless of status", () => {
    expect(isInsufficientCredits(new ApiError(400, "INSUFFICIENT_CREDITS", "nope"))).toBe(true);
  });

  it("is false for an unrelated ApiError", () => {
    expect(isInsufficientCredits(new ApiError(500, "INTERNAL", "boom"))).toBe(false);
  });

  it("is false for a non-ApiError value", () => {
    expect(isInsufficientCredits(new Error("boom"))).toBe(false);
    expect(isInsufficientCredits(null)).toBe(false);
    expect(isInsufficientCredits(undefined)).toBe(false);
  });
});
