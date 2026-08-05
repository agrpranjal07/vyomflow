-- Attaching a file from the empty-state composer (before any chat exists)
-- must not force-create a real Chat row just to satisfy this FK — that
-- created an orphan "New chat" row visible in the sidebar as soon as the
-- upload started, not on send. chatId is now bound (alongside messageId)
-- atomically in bindAttachmentsToMessage once a chat actually exists.
ALTER TABLE "attachments" ALTER COLUMN "chatId" DROP NOT NULL;
