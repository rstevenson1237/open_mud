-- AlterTable
ALTER TABLE "Avatar" ADD COLUMN     "sanity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sanityMax" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "visitedRegions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "woundMax" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "Condition" ADD COLUMN     "overrideAction" TEXT,
ADD COLUMN     "overridesInput" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorldState" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}';
