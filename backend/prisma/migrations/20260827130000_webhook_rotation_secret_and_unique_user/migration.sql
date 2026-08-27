-- Phase 6 (signed outbound webhooks): add the rotation-slot secret column
-- and enforce "one WebhookEndpoint row per user" at the database level,
-- matching the plan's minimal-scope model (a single POST route sets/rotates
-- the caller's own endpoint; there is no per-event-type subscription list).

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN "secondarySecret" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_userId_key" ON "webhook_endpoints"("userId");
