/*
  Warnings:

  - You are about to drop the column `magicaRunId` on the `tool_invocations` table. All the data in the column will be lost.
  - You are about to drop the column `subModelId` on the `tool_invocations` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[chatId]` on the table `agent_runs` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "agent_runs_chatId_key";

-- AlterTable
ALTER TABLE "tool_invocations" DROP COLUMN "magicaRunId",
DROP COLUMN "subModelId";

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_chatId_key" ON "agent_runs"("chatId") WHERE (status IN ('queued','running','waiting'));
