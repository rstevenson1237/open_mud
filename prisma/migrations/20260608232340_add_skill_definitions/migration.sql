-- CreateTable
CREATE TABLE "SkillDefinition" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "stat" TEXT NOT NULL,
    "rollContribution" INTEGER NOT NULL,
    "autoSucceedSimple" BOOLEAN NOT NULL DEFAULT false,
    "prerequisites" JSONB NOT NULL DEFAULT '[]',
    "unlocksActions" JSONB NOT NULL DEFAULT '[]',
    "attachedToObject" BOOLEAN NOT NULL DEFAULT false,
    "regionScoped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "SkillDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillDefinition_name_key" ON "SkillDefinition"("name");
