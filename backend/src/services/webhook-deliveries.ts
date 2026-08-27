/**
 * WebhookDelivery row lifecycle helpers (S8 Phase 6), mirroring
 * services/tool-invocations.ts's convention: the child task
 * (src/trigger/webhook-delivery.ts) owns every transition, guarded so a
 * late writer can never resurrect or overwrite an already-terminal row.
 */
import { prisma } from "@/lib/db";

/** pending -> delivered (terminal, success). Guarded so a stray late retry attempt can never un-deliver a row. */
export async function markDeliveryDelivered(params: {
  deliveryId: string;
  statusCode: number;
  attempt: number;
}): Promise<boolean> {
  const { deliveryId, statusCode, attempt } = params;
  const { count } = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending" },
    data: { status: "delivered", lastStatusCode: statusCode, attempt, deliveredAt: new Date() },
  });
  return count > 0;
}

/** Records one failed attempt without settling the row — more retries are still scheduled. */
export async function recordDeliveryAttemptFailure(params: {
  deliveryId: string;
  statusCode: number | null;
  attempt: number;
}): Promise<void> {
  const { deliveryId, statusCode, attempt } = params;
  await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending" },
    data: { attempt, lastStatusCode: statusCode },
  });
}

/**
 * pending -> dead (terminal, retries exhausted). Never touches
 * `lastStatusCode`/`attempt` — the last `recordDeliveryAttemptFailure` call
 * already recorded those for the same final attempt; this only flips the
 * row's status.
 */
export async function markDeliveryDead(deliveryId: string): Promise<boolean> {
  const { count } = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending" },
    data: { status: "dead" },
  });
  return count > 0;
}
