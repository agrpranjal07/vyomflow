import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));
// This suite doesn't care about skill content — avoid the cwd/chdir dance the skills-orchestration
// suite needs, since executeAgentTurn now always composes the skill roster into the system prompt.
vi.mock("@/server/skills/registry", () => ({ listSkillMetadata: vi.fn().mockResolvedValue([]) }));

const { runAgentLoop, streamWrite } = vi.hoisted(() => ({ runAgentLoop: vi.fn(), streamWrite: vi.fn() }));
vi.mock("@/server/agent/loop", () => ({ runAgentLoop }));
vi.mock("@/trigger/streams", () => ({
  assistantStream: {
    writer: (opts: { execute: (arg: { write: (part: unknown) => void }) => Promise<void> }) => ({
      waitUntilComplete: () => opts.execute({ write: streamWrite }),
    }),
  },
}));

import { POST as createChat } from "@/app/api/v1/chats/route";
import { POST as sendMessage } from "@/app/api/v1/chats/[chatId]/messages/route";
import { executeAgentTurn } from "@/trigger/turn";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";

const BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

async function sendAs(userId: string, chatId: string) {
  const res = await sendMessage(
    authedRequest(`${BASE}/${chatId}/messages`, userId, {
      method: "POST",
      body: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
    }),
    { params: Promise.resolve({ chatId }) },
  );
  return res.json();
}

function fakeCtx(triggerRunId: string) {
  return { ctx: { run: { id: triggerRunId } }, signal: new AbortController().signal };
}

beforeEach(() => {
  resetTriggerMocks();
  runAgentLoop.mockReset();
  streamWrite.mockReset();
});

describe("executeAgentTurn — first-delta checkpoint prevents a double generation after a crash (hardening pass)", () => {
  it("a crash after the first realtime delta but before the throttled checkpoint leaves real progress persisted, so a retry finalizes as failed instead of calling the provider again", async () => {
    const userId = "user_turn_retry_1";
    const chat = await createChatAs(userId);
    const { run, message } = await sendAs(userId, chat.id);
    const payload = { runId: run.id, chatId: chat.id, userMessageId: message.id, userId, requestedModel: run.requestedModel };

    // Attempt 1: the provider streams exactly one token, then the "worker"
    // crashes (simulated as a thrown error — a real crash would just never
    // resolve `run()`, but for this test what matters is that the attempt
    // stops immediately after the first onDelta call, well before
    // STREAM_CHECKPOINT_EVERY_N_DELTAS/STREAM_CHECKPOINT_INTERVAL_MS would
    // ever fire a throttled checkpoint on their own).
    runAgentLoop.mockImplementationOnce(
      async ({ onDelta }: { onDelta: (part: { index: number; delta: string }) => Promise<void> }) => {
        await onDelta({ index: 0, delta: "Hel" });
        throw new Error("simulated worker crash");
      },
    );

    await expect(executeAgentTurn(payload, fakeCtx("trigger_attempt_1"))).rejects.toThrow("simulated worker crash");

    const afterAttempt1 = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    // The bug this closes: without the first-delta forced checkpoint, this
    // would still read -1 here (only one token arrived, nowhere near a
    // throttled checkpoint), so the retry-guard below would never trip.
    expect(afterAttempt1.lastStreamIndex).toBe(0);
    expect(afterAttempt1.status).toBe("running");
    expect(streamWrite).toHaveBeenCalledTimes(1);

    // Attempt 2 (Trigger.dev's retry of the same run): must see real
    // progress and finalize as failed WITHOUT invoking the provider again.
    await executeAgentTurn(payload, fakeCtx("trigger_attempt_2"));

    expect(runAgentLoop).toHaveBeenCalledTimes(1); // never called for the retry

    const afterRetry = await testDb.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterRetry.status).toBe("failed");
    expect(afterRetry.errorCode).toBe("generation_interrupted");
  });
});
