-- CreateEnum
CREATE TYPE "AssetIngestStatus" AS ENUM ('PENDING', 'INGESTED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "tool_invocations" ADD COLUMN     "assemblyId" TEXT,
ADD COLUMN     "assetIngestStatus" "AssetIngestStatus",
ADD COLUMN     "sourceUrls" JSONB;
