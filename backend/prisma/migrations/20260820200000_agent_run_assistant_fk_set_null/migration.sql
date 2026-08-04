-- assistantMessageId is nullable and only ever set once the assistant
-- Message is durably written (src/server/agent/persist.ts) — deleting that
-- message later must not cascade-delete the whole AgentRun row (its
-- userMessageId FK stays CASCADE; deleting the run's own request message is
-- a genuine "delete this run" intent, unlike deleting its produced reply).

-- DropForeignKey
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_assistantMessageId_fkey";

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
