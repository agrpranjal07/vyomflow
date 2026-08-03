/**
 * Shared mock for src/server/dispatch.ts — the seam between the send/
 * cancel/realtime-token routes and Trigger.dev. Every integration test
 * that exercises those routes mocks this module so no automated test ever
 * reaches the Trigger.dev cloud (S2 implementation plan §J).
 *
 * Usage in a test file (the `vi.mock` call itself must live in the test
 * file, not here, so Vitest can hoist it before that file's other imports):
 *
 *   import { vi, beforeEach } from "vitest";
 *   vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
 *   import { dispatchAgentTurn, resetTriggerMocks } from "../support/trigger-mock";
 *   beforeEach(() => resetTriggerMocks());
 */
import { vi } from "vitest";

export const ASSISTANT_STREAM_KEY = "assistant";

export const dispatchAgentTurn = vi.fn(async (payload: { runId: string }) => ({
  triggerRunId: `run_test_${payload.runId}`,
  accessToken: "test-access-token",
}));

export const mintRealtimeToken = vi.fn(async (triggerRunId: string) => ({
  accessToken: `test-access-token-${triggerRunId}`,
  expiresAt: new Date(Date.now() + 15 * 60_000),
}));

export const cancelTriggerRun = vi.fn(async () => undefined);

export function resetTriggerMocks() {
  dispatchAgentTurn.mockClear();
  mintRealtimeToken.mockClear();
  cancelTriggerRun.mockClear();
}
