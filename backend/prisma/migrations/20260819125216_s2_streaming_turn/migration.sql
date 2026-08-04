-- CreateEnum
CREATE TYPE "CreditHoldStatus" AS ENUM ('OPEN', 'CAPTURED', 'RELEASED');

-- CreateEnum
CREATE TYPE "CreditLedgerKind" AS ENUM ('RESERVE', 'CAPTURE', 'RELEASE', 'USAGE');

-- DropIndex
DROP INDEX "agent_runs_chatId_key";

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "assistantMessageId" TEXT,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "requestedModel" TEXT NOT NULL,
ADD COLUMN     "resolvedModel" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "triggerRunId" TEXT,
ADD COLUMN     "turnCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "userMessageId" TEXT NOT NULL,
ALTER COLUMN "lastStreamIndex" SET DEFAULT -1;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "creditBalance" SET DEFAULT 100.0000;

-- CreateTable
CREATE TABLE "credit_holds" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "status" "CreditHoldStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "toolInvocationId" TEXT,
    "kind" "CreditLedgerKind" NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_windows" (
    "userId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_runId_key" ON "credit_holds"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_idempotencyKey_key" ON "credit_ledger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_ledger_userId_createdAt_idx" ON "credit_ledger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_windows_userId_windowStart_key" ON "rate_limit_windows"("userId", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_userMessageId_key" ON "agent_runs"("userMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_assistantMessageId_key" ON "agent_runs"("assistantMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_triggerRunId_key" ON "agent_runs"("triggerRunId");

-- CreateIndex
CREATE INDEX "agent_runs_status_updatedAt_idx" ON "agent_runs"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_chatId_key" ON "agent_runs"("chatId") WHERE (status IN ('queued','running','waiting'));

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

