import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDb } from "../support/db";
import { authedRequest, anonymousRequest } from "../support/request";
import { POST as createApiKeyRoute } from "@/app/api/v1/api-keys/route";
import { clerkClient } from "@/lib/auth";
import { PUBLIC_API_DEFAULT_SCOPES } from "@/lib/api-key-scopes";

const API_KEYS_URL = "http://localhost/api/v1/api-keys";

async function makeUser(clerkUserId: string) {
  return testDb.user.create({ data: { clerkUserId } });
}

/**
 * Fake `APIKey` resource shaped like `@clerk/backend`'s real one (only the
 * fields our service reads: id/name/subject/scopes/secret/expiration).
 */
function fakeApiKey(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ak_test_1",
    type: "api_key",
    name: "test key",
    subject: "user_test",
    scopes: [...PUBLIC_API_DEFAULT_SCOPES],
    claims: null,
    revoked: false,
    revocationReason: null,
    expired: false,
    expiration: null,
    createdBy: null,
    description: null,
    lastUsedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    secret: "sk_test_secret_value",
    ...overrides,
  };
}

describe("POST /api/v1/api-keys — backend-mediated scoped key creation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires session-token authentication", async () => {
    const res = await createApiKeyRoute(
      anonymousRequest(API_KEYS_URL, { method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const user = await makeUser("user_apikey_badbody");
    const res = await createApiKeyRoute(
      authedRequest(API_KEYS_URL, user.clerkUserId, { method: "POST", body: JSON.stringify({ name: "" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a key scoped to exactly PUBLIC_API_DEFAULT_SCOPES and returns the secret", async () => {
    const user = await makeUser("user_apikey_create");
    const createSpy = vi
      .spyOn(clerkClient.apiKeys, "create")
      .mockResolvedValue(
        fakeApiKey({ subject: user.clerkUserId, name: "My integration" }) as never,
      );

    const res = await createApiKeyRoute(
      authedRequest(API_KEYS_URL, user.clerkUserId, {
        method: "POST",
        body: JSON.stringify({ name: "My integration" }),
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.secret).toBe("sk_test_secret_value");
    expect(body.name).toBe("My integration");
    expect(body.scopes).toEqual([...PUBLIC_API_DEFAULT_SCOPES]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [callArgs] = createSpy.mock.calls[0]!;
    expect(callArgs.subject).toBe(user.clerkUserId);
    expect(callArgs.scopes).toEqual([...PUBLIC_API_DEFAULT_SCOPES]);
  });

  it("passes expirationDays through as secondsUntilExpiration", async () => {
    const user = await makeUser("user_apikey_expiry");
    const createSpy = vi
      .spyOn(clerkClient.apiKeys, "create")
      .mockResolvedValue(fakeApiKey({ subject: user.clerkUserId }) as never);

    const res = await createApiKeyRoute(
      authedRequest(API_KEYS_URL, user.clerkUserId, {
        method: "POST",
        body: JSON.stringify({ name: "expiring key", expirationDays: 7 }),
      }),
    );
    expect(res.status).toBe(201);
    const [callArgs] = createSpy.mock.calls[0]!;
    expect(callArgs.secondsUntilExpiration).toBe(7 * 86400);
  });
});
