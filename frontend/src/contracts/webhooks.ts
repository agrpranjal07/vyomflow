// GENERATED — do not edit. Source: 1173916808585c5b39a4dfd2d96256d6ec489be5:src/contracts/webhooks.ts
/**
 * S8 Phase 6 — signed outbound webhooks (minimal scope, per the plan: one
 * `WebhookEndpoint` row per user, no per-event subscriptions, no UI). Pure
 * Zod only, same rules as every other file under src/contracts/** — copied
 * verbatim into the frontend by `contracts:sync` (unused today since there
 * is no webhooks UI yet, but kept consistent with every other DTO in this
 * directory).
 */
import { z } from "zod";

export const SetWebhookEndpointRequestSchema = z.object({
  url: z.string().url(),
  // When true and an endpoint already exists, the current `secret` is moved
  // into `secondarySecret` (kept valid for a grace window) and a fresh
  // `secret` is generated. Ignored on first registration — there is nothing
  // to rotate yet.
  rotateSecret: z.boolean().optional(),
});
export type SetWebhookEndpointRequest = z.infer<typeof SetWebhookEndpointRequestSchema>;

/**
 * Both secrets are returned in plaintext — this is the only place they are
 * ever surfaced (VyomFlow never stores or displays them again after this
 * response), since the receiver needs the literal value to verify
 * `X-Vyomflow-Signature`. Never logged.
 */
export const WebhookEndpointDTOSchema = z.object({
  id: z.string(),
  url: z.string(),
  secret: z.string(),
  secondarySecret: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookEndpointDTO = z.infer<typeof WebhookEndpointDTOSchema>;
