import { describe, it, expect } from "vitest";
import { CreditApprovalRequestPayloadSchema } from "@/contracts/waitpoints";

describe("CreditApprovalRequestPayloadSchema — legacy single-call payload backfill (2026-08-29)", () => {
  it("upgrades a legacy single-call payload to the current round shape", () => {
    const result = CreditApprovalRequestPayloadSchema.safeParse({
      toolName: "generate_image",
      estimatedCredits: 0.1,
      threshold: 0.08,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      calls: [{ toolCallId: "", toolName: "generate_image", estimatedCredits: 0.1 }],
      estimatedCredits: 0.1,
      threshold: 0.08,
    });
  });

  it("passes an already-current multi-call payload through unchanged", () => {
    const current = {
      calls: [
        { toolCallId: "call_1", toolName: "generate_image", estimatedCredits: 0.1 },
        { toolCallId: "call_2", toolName: "crop_image", estimatedCredits: 0.05 },
      ],
      estimatedCredits: 0.15,
      threshold: 0.08,
    };
    const result = CreditApprovalRequestPayloadSchema.safeParse(current);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(current);
  });

  it.each([{}, { foo: "bar" }, null])("rejects garbage payload %j rather than coercing it", (garbage) => {
    const result = CreditApprovalRequestPayloadSchema.safeParse(garbage);
    expect(result.success).toBe(false);
  });

  it("defaults a missing estimatedCredits on a legacy payload to 0 rather than failing", () => {
    const result = CreditApprovalRequestPayloadSchema.safeParse({ toolName: "x", threshold: 0.08 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      calls: [{ toolCallId: "", toolName: "x", estimatedCredits: 0 }],
      estimatedCredits: 0,
      threshold: 0.08,
    });
  });
});
