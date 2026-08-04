-- CreateEnum
CREATE TYPE "ToolInvocationStatus" AS ENUM ('DISPATCHING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- DropIndex
DROP INDEX "agent_runs_chatId_key";

-- AlterTable
ALTER TABLE "credit_holds" ADD COLUMN     "capturedAmount" DECIMAL(12,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "callIndex" INTEGER NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "subModelId" TEXT,
    "input" JSONB NOT NULL,
    "magicaRunId" TEXT,
    "status" "ToolInvocationStatus" NOT NULL DEFAULT 'DISPATCHING',
    "creditEstimate" DECIMAL(12,4),
    "creditUsed" DECIMAL(12,4),
    "resultUrls" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_invocations_status_updatedAt_idx" ON "tool_invocations"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tool_invocations_agentRunId_toolCallId_key" ON "tool_invocations"("agentRunId", "toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_chatId_key" ON "agent_runs"("chatId") WHERE (status IN ('queued','running','waiting'));

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_toolInvocationId_fkey" FOREIGN KEY ("toolInvocationId") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

