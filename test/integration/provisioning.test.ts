import { describe, it, expect } from "vitest";
import { GET as listChats } from "@/app/api/v1/chats/route";
import { authedRequest } from "../support/request";
import { testDb } from "../support/db";

describe("first-sight user provisioning", () => {
  it("creates exactly one User row under a concurrent double-submit for the same Clerk id", async () => {
    const clerkUserId = "user_race";

    // Fire N concurrent first-sight requests; each independently calls the
    // upsert-based provisioning path in src/lib/auth.ts.
    await Promise.all(
      Array.from({ length: 10 }, () => listChats(authedRequest("http://localhost/api/v1/chats", clerkUserId))),
    );

    const users = await testDb.user.findMany({ where: { clerkUserId } });
    expect(users).toHaveLength(1);
  });
});
