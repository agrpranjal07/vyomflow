/**
 * Backend-mediated API key creation (fixes the zero-scope-key bug: Clerk's
 * Frontend API / `<APIKeys/>` widget can never attach scopes or claims to a
 * key it mints — confirmed via Context7 `/clerk/clerk-docs`. Scopes can only
 * be set through the Backend API, server-side, with the secret key — this
 * is that server-side call). Account-management action, not a data
 * contract synced to the frontend, so its request schema lives here rather
 * than under src/contracts/**.
 */
import { z } from "zod";
import { clerkClient } from "@/lib/auth";
import { PUBLIC_API_DEFAULT_SCOPES } from "@/lib/api-key-scopes";

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(256),
  expirationDays: z.number().int().positive().optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export interface CreateApiKeyResult {
  id: string;
  name: string;
  secret: string;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * Mints a key scoped to `PUBLIC_API_DEFAULT_SCOPES` for the given Clerk
 * user. `secret` is the raw key value, present exactly once on this
 * response (mirrors Clerk's own `APIKeyResource.secret` behavior) — never
 * persisted or logged by this service.
 */
export async function createApiKey(clerkUserId: string, input: CreateApiKeyRequest): Promise<CreateApiKeyResult> {
  const apiKey = await clerkClient.apiKeys.create({
    name: input.name,
    subject: clerkUserId,
    scopes: [...PUBLIC_API_DEFAULT_SCOPES],
    secondsUntilExpiration: input.expirationDays ? input.expirationDays * 86400 : undefined,
  });

  return {
    id: apiKey.id,
    name: apiKey.name,
    secret: apiKey.secret ?? "",
    scopes: apiKey.scopes ?? [],
    expiresAt: apiKey.expiration ? new Date(apiKey.expiration).toISOString() : null,
  };
}
