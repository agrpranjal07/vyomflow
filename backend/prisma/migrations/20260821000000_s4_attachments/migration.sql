-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "messageId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "assemblyId" TEXT,
    "mimeType" TEXT,
    "byteSize" INTEGER,
    "fileName" TEXT,
    "resultUrl" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_assemblyId_key" ON "attachments"("assemblyId");

-- CreateIndex
CREATE INDEX "attachments_chatId_messageId_orderIndex_idx" ON "attachments"("chatId", "messageId", "orderIndex");

-- CreateIndex
CREATE INDEX "attachments_ownerId_createdAt_id_idx" ON "attachments"("ownerId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
