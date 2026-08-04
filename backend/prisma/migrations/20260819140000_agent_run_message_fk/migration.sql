-- Referential integrity for AgentRun's message links (audit item 2):
-- userMessageId/assistantMessageId were unique-indexed but never
-- FK-constrained to messages(id), so an orphaned/foreign id was only
-- prevented at the application layer. Safe against existing rows: both
-- columns are only ever populated with genuine Message ids created in the
-- same transaction (see src/services/send-turn.ts, src/server/agent/persist.ts).

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
