-- CreateEnum
CREATE TYPE "WaitpointKind" AS ENUM ('CREDIT_APPROVAL', 'CLARIFICATION');

-- CreateEnum
CREATE TYPE "WaitpointStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');

-- CreateTable
CREATE TABLE "waitpoints" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "triggerTokenId" TEXT NOT NULL,
    "kind" "WaitpointKind" NOT NULL,
    "status" "WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "requestPayload" JSONB NOT NULL,
    "resolvedPayload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "waitpoints_triggerTokenId_key" ON "waitpoints"("triggerTokenId");

-- CreateIndex
CREATE INDEX "waitpoints_status_expiresAt_idx" ON "waitpoints"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "waitpoints" ADD CONSTRAINT "waitpoints_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
