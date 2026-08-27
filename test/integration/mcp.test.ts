/**
 * S8 Phase 5 — MCP server integration tests. Drives the real Route Handler
 * (`POST /api/mcp`) with raw JSON-RPC bodies over the legacy-stateless
 * transport `createMcpHandler` falls back to for claim-less requests (the
 * "modern" 2026-07-28 per-request envelope is not exercised here — plain
 * JSON-RPC is what every current MCP client actually sends). Covers:
 * initialize, tools/list (all 8, correct schemas), each tool's happy path,
 * the ACTIVE_RUN_EXISTS structured error, and an approval answered via
 * vyomflow_respond_waitpoint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/dispatch", () => import("../support/trigger-mock"));

import { POST as mcpPost } from "@/app/api/mcp/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";
import { resetTriggerMocks } from "../support/trigger-mock";
import { POST as createChat } from "@/app/api/v1/chats/route";

const MCP_URL = "http://localhost/api/mcp";
const CHATS_BASE = "http://localhost/api/v1/chats";

async function createChatAs(userId: string) {
  const res = await createChat(authedRequest(CHATS_BASE, userId, { method: "POST", body: JSON.stringify({ title: "Chat" }) }));
  return res.json();
}

/** Parses either a plain JSON response or the legacy transport's SSE-framed response into the JSON-RPC message(s) it carries. */
async function parseMcpMessages(res: Response): Promise<Record<string, unknown>[]> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return [await res.json()];
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

function call(userId: string, scopes: string[], body: unknown) {
  return mcpPost(
    authedRequest(MCP_URL, userId, {
      method: "POST",
      scopes,
      body: JSON.stringify(body),
      headers: { Accept: "application/json, text/event-stream" },
    }),
  );
}

/** Sends one JSON-RPC request and returns its matching result/error message. */
async function rpc(userId: string, method: string, params: unknown, id = 1) {
  const res = await call(userId, ["chats:write", "chats:read", "runs:write", "runs:read", "waitpoints:respond", "credits:read"], {
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  const messages = await parseMcpMessages(res);
  const match = messages.find((m) => m.id === id);
  return { httpStatus: res.status, message: match };
}

function toolCallResult(message: Record<string, unknown> | undefined) {
  const result = message?.result as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  return { isError: result?.isError ?? false, payload: text ? JSON.parse(text) : undefined };
}

beforeEach(() => {
  resetTriggerMocks();
});

describe("MCP server — transport + tool surface", () => {
  it("session_token callers are rejected outright — MCP is API-key-only", async () => {
    const res = await mcpPost(
      authedRequest(MCP_URL, "user_mcp_session", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        headers: { Accept: "application/json, text/event-stream" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("initialize succeeds and tools/list advertises all 8 tools", async () => {
    const userId = "user_mcp_list";
    const init = await rpc(userId, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0" },
    });
    expect(init.message?.result).toBeTruthy();

    const list = await rpc(userId, "tools/list", {}, 2);
    const tools = (list.message?.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "vyomflow_cancel_run",
        "vyomflow_create_chat",
        "vyomflow_get_credits",
        "vyomflow_get_run",
        "vyomflow_list_chats",
        "vyomflow_respond_waitpoint",
        "vyomflow_send_message",
        "vyomflow_wait_for_run",
      ].sort(),
    );
  });

  it("vyomflow_create_chat + vyomflow_list_chats happy path", async () => {
    const userId = "user_mcp_chat";
    const created = await rpc(userId, "tools/call", { name: "vyomflow_create_chat", arguments: { title: "From MCP" } }, 1);
    const createdResult = toolCallResult(created.message);
    expect(createdResult.isError).toBe(false);
    expect(createdResult.payload.title).toBe("From MCP");

    const listed = await rpc(userId, "tools/call", { name: "vyomflow_list_chats", arguments: {} }, 2);
    const listedResult = toolCallResult(listed.message);
    expect(listedResult.isError).toBe(false);
    expect(Array.isArray(listedResult.payload.items)).toBe(true);
  });

  it("vyomflow_send_message dispatches, waits, and returns a run snapshot; a second send on the same chat returns ACTIVE_RUN_EXISTS", async () => {
    const userId = "user_mcp_send";
    const chat = await createChatAs(userId);

    const sent = await rpc(
      userId,
      "tools/call",
      { name: "vyomflow_send_message", arguments: { chatId: chat.id, content: "hello", waitSeconds: 0 } },
      1,
    );
    const sentResult = toolCallResult(sent.message);
    expect(sentResult.isError).toBe(false);
    expect(sentResult.payload.runId).toBeTruthy();
    expect(sentResult.payload.status).toBe("queued");

    const secondSend = await rpc(
      userId,
      "tools/call",
      { name: "vyomflow_send_message", arguments: { chatId: chat.id, content: "again", waitSeconds: 0 } },
      2,
    );
    const secondResult = toolCallResult(secondSend.message);
    expect(secondResult.isError).toBe(true);
    expect(secondResult.payload.code).toBe("ACTIVE_RUN_EXISTS");
    expect(secondResult.payload.runId).toBe(sentResult.payload.runId);
  });

  it("vyomflow_get_run reflects a terminal run without blocking, and vyomflow_wait_for_run reports done: true", async () => {
    const userId = "user_mcp_terminal";
    const chat = await createChatAs(userId);
    const sent = await rpc(userId, "tools/call", { name: "vyomflow_send_message", arguments: { chatId: chat.id, content: "hi", waitSeconds: 0 } }, 1);
    const runId = toolCallResult(sent.message).payload.runId as string;

    await testDb.agentRun.update({ where: { id: runId }, data: { status: "completed", finishedAt: new Date() } });

    const got = await rpc(userId, "tools/call", { name: "vyomflow_get_run", arguments: { runId } }, 2);
    expect(toolCallResult(got.message).payload.status).toBe("completed");

    const waited = await rpc(userId, "tools/call", { name: "vyomflow_wait_for_run", arguments: { runId, waitSeconds: 0 } }, 3);
    const waitedResult = toolCallResult(waited.message);
    expect(waitedResult.payload.done).toBe(true);
    expect(waitedResult.payload.status).toBe("completed");
  });

  it("vyomflow_respond_waitpoint resolves a pending CREDIT_APPROVAL waitpoint and is idempotent on repeat", async () => {
    const userId = "user_mcp_waitpoint";
    const chat = await createChatAs(userId);
    const sent = await rpc(userId, "tools/call", { name: "vyomflow_send_message", arguments: { chatId: chat.id, content: "hi", waitSeconds: 0 } }, 1);
    const runId = toolCallResult(sent.message).payload.runId as string;

    const waitpoint = await testDb.waitpoint.create({
      data: {
        agentRunId: runId,
        kind: "CREDIT_APPROVAL",
        requestPayload: { toolName: "crop_image", estimatedCredits: 0.1, threshold: 0.08 },
        triggerTokenId: `wpt_mcp_${runId}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await testDb.agentRun.update({ where: { id: runId }, data: { status: "waiting" } });

    const responded = await rpc(
      userId,
      "tools/call",
      { name: "vyomflow_respond_waitpoint", arguments: { waitpointId: waitpoint.id, kind: "CREDIT_APPROVAL", approved: true } },
      2,
    );
    const respondedResult = toolCallResult(responded.message);
    expect(respondedResult.isError).toBe(false);
    expect(respondedResult.payload.waitpoint.status).toBe("COMPLETED");
    expect(respondedResult.payload.alreadyResolved).toBe(false);

    const again = await rpc(
      userId,
      "tools/call",
      { name: "vyomflow_respond_waitpoint", arguments: { waitpointId: waitpoint.id, kind: "CREDIT_APPROVAL", approved: false } },
      3,
    );
    const againResult = toolCallResult(again.message);
    expect(againResult.payload.alreadyResolved).toBe(true);
    expect(againResult.payload.waitpoint.resolvedPayload.approved).toBe(true);
  });

  it("vyomflow_get_credits returns the caller's balance", async () => {
    const userId = "user_mcp_credits";
    const res = await rpc(userId, "tools/call", { name: "vyomflow_get_credits", arguments: {} }, 1);
    const result = toolCallResult(res.message);
    expect(result.isError).toBe(false);
    expect(typeof result.payload.available).toBe("string");
  });

  it("vyomflow_cancel_run is idempotent on an already-terminal run", async () => {
    const userId = "user_mcp_cancel";
    const chat = await createChatAs(userId);
    const sent = await rpc(userId, "tools/call", { name: "vyomflow_send_message", arguments: { chatId: chat.id, content: "hi", waitSeconds: 0 } }, 1);
    const runId = toolCallResult(sent.message).payload.runId as string;
    await testDb.agentRun.update({ where: { id: runId }, data: { status: "completed", finishedAt: new Date() } });

    const cancelled = await rpc(userId, "tools/call", { name: "vyomflow_cancel_run", arguments: { runId } }, 2);
    const result = toolCallResult(cancelled.message);
    expect(result.isError).toBe(false);
    expect(result.payload.status).toBe("completed");
  });
});
