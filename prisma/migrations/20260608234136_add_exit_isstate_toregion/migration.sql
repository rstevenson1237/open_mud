-- AlterTable
ALTER TABLE "Exit" ADD COLUMN     "isState" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "toRegionId" INTEGER;
