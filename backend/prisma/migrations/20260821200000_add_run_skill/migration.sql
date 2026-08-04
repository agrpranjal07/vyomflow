-- DropIndex
DROP INDEX "agent_runs_chatId_key";

-- CreateTable
CREATE TABLE "run_skills" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_skills_agentRunId_skillName_key" ON "run_skills"("agentRunId", "skillName");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_chatId_key" ON "agent_runs"("chatId") WHERE (status IN ('queued','running','waiting'));

-- AddForeignKey
ALTER TABLE "run_skills" ADD CONSTRAINT "run_skills_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

