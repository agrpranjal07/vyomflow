/**
 * S8 Phase 6 — WebhookEndpoint set/rotate service. One row per user
 * (`@@unique([userId])` on the model, prisma/schema.prisma), matching the
 * plan's minimal scope: no per-event subscriptions, no UI. Secrets are
 * generated server-side (32 random bytes, hex-encoded) — the caller never
 * supplies one, so a weak/guessable secret can never be registered.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import type { WebhookEndpoint } from "@/generated/prisma/client";
import type { WebhookEndpointDTO, SetWebhookEndpointRequest } from "@/contracts/webhooks";

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

export function toWebhookEndpointDTO(row: WebhookEndpoint): WebhookEndpointDTO {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    secondarySecret: row.secondarySecret,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Creates the caller's endpoint on first call; on every subsequent call
 * updates `url` and, only when `rotateSecret` is explicitly requested,
 * shifts the current `secret` into `secondarySecret` (both remain valid
 * signers of newly-enqueued deliveries — see server/webhooks/signing.ts —
 * so the receiver has a grace window to switch over) and mints a fresh
 * `secret`. `rotateSecret` on first registration is a no-op (nothing to
 * rotate yet, and generating two secrets a caller never asked for would
 * add avoidable surface).
 */
export async function setWebhookEndpoint(
  userId: string,
  input: SetWebhookEndpointRequest,
): Promise<WebhookEndpointDTO> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { userId } });

  if (!existing) {
    const created = await prisma.webhookEndpoint.create({
      data: { userId, url: input.url, secret: generateSecret() },
    });
    return toWebhookEndpointDTO(created);
  }

  const updated = await prisma.webhookEndpoint.update({
    where: { userId },
    data: input.rotateSecret
      ? { url: input.url, secret: generateSecret(), secondarySecret: existing.secret }
      : { url: input.url },
  });
  return toWebhookEndpointDTO(updated);
}

/** Best-effort lookup used by the emitter — returns null when the user has no enabled endpoint. */
export async function getEnabledWebhookEndpoint(userId: string): Promise<WebhookEndpoint | null> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { userId } });
  return endpoint && endpoint.enabled ? endpoint : null;
}
