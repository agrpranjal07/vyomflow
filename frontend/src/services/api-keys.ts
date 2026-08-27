import { z } from "zod";
import type { Fetcher } from "@/lib/api-client";

/**
 * Account-management response, not a synced data contract — the matching
 * backend Zod schema lives next to its route/service
 * (backend/src/services/api-keys.ts), not under src/contracts/**.
 */
export const CreateApiKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  secret: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;

/** POST /api/v1/api-keys — mints a scoped public-API key via the backend (Clerk Backend API), never the Frontend API. */
export async function createApiKey(
  fetcher: Fetcher,
  input: { name: string; expirationDays?: number },
): Promise<CreateApiKeyResponse> {
  const raw = await fetcher("/api/v1/api-keys", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return CreateApiKeyResponseSchema.parse(raw);
}
