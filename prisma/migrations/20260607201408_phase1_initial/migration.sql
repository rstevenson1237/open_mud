-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('ROOT', 'ADMIN', 'POWER_USER', 'CHARACTER', 'GHOST', 'EXTENDED');

-- CreateEnum
CREATE TYPE "PermissionLevel" AS ENUM ('OWNED_BY', 'GRANTED', 'DENIED');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'AVATAR', 'LOCATION', 'REGION', 'WORLD', 'CONTAINER', 'ESCROW', 'EXTENDED');

-- CreateEnum
CREATE TYPE "ObjectType" AS ENUM ('ITEM', 'CONTAINER', 'WEAPON', 'ARMOR', 'KEY', 'CONSUMABLE', 'FIXTURE', 'MOB', 'COIN', 'VENDOR', 'EXTENDED');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('SAFE', 'OPEN', 'DANGEROUS', 'EXTENDED');

-- CreateEnum
CREATE TYPE "ConditionType" AS ENUM ('MECHANICAL', 'GAME', 'EXTENDED');

-- CreateEnum
CREATE TYPE "ScriptAttachType" AS ENUM ('OBJECT_TEMPLATE', 'OBJECT_INSTANCE', 'LOCATION', 'EXIT', 'REGION', 'AVATAR', 'EXTENDED');

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL,
    "type" "UserType" NOT NULL DEFAULT 'CHARACTER',
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "sessionToken" TEXT,
    "sessionExpiry" TIMESTAMP(3),
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "inboxLimit" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Avatar" (
    "id" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" INTEGER,
    "locationId" INTEGER,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "skills" JSONB NOT NULL DEFAULT '{}',
    "wounds" INTEGER NOT NULL DEFAULT 0,
    "stress" INTEGER NOT NULL DEFAULT 0,
    "hunger" INTEGER NOT NULL DEFAULT 0,
    "rest" INTEGER NOT NULL DEFAULT 100,
    "carryCapacity" INTEGER NOT NULL DEFAULT 100,
    "encumberedThreshold" INTEGER NOT NULL DEFAULT 80,
    "activeConditions" JSONB NOT NULL DEFAULT '[]',
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Avatar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" INTEGER,
    "config" JSONB NOT NULL DEFAULT '{}',
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" INTEGER NOT NULL,
    "regionId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "zoneType" "ZoneType" NOT NULL DEFAULT 'SAFE',
    "scriptId" INTEGER,
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("regionId","id")
);

-- CreateTable
CREATE TABLE "Exit" (
    "id" INTEGER NOT NULL,
    "regionId" INTEGER NOT NULL,
    "fromLocationId" INTEGER NOT NULL,
    "toLocationId" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "conditionId" INTEGER,
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Exit_pkey" PRIMARY KEY ("regionId","id")
);

-- CreateTable
CREATE TABLE "ObjectTemplate" (
    "id" INTEGER NOT NULL,
    "regionId" INTEGER,
    "name" TEXT NOT NULL,
    "type" "ObjectType" NOT NULL,
    "baseSchema" JSONB NOT NULL DEFAULT '{}',
    "scriptId" INTEGER,
    "lootTable" JSONB NOT NULL DEFAULT '[]',
    "aliases" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "ObjectTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectInstance" (
    "pk" SERIAL NOT NULL,
    "id" INTEGER NOT NULL,
    "regionId" INTEGER,
    "templateId" INTEGER NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "isState" JSONB NOT NULL DEFAULT '{}',
    "activeConditions" JSONB NOT NULL DEFAULT '[]',
    "count" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "ObjectInstance_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" SERIAL NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "level" "PermissionLevel" NOT NULL,
    "grantedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionLog" (
    "id" SERIAL NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "PermissionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" SERIAL NOT NULL,
    "attachedToType" "ScriptAttachType" NOT NULL,
    "attachedToId" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "maxTransitions" INTEGER,
    "maxEvents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ConditionType" NOT NULL,
    "affectedStat" TEXT,
    "modifier" INTEGER NOT NULL DEFAULT 0,
    "visibilityEffect" TEXT NOT NULL DEFAULT 'none',
    "defaultDurationTicks" INTEGER,
    "regionScoped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "fromAvatarId" INTEGER,
    "toAvatarId" INTEGER,
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "attachedInstanceId" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorldState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tickCount" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFlushAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "WorldState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectInstance_regionId_id_key" ON "ObjectInstance"("regionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Condition_name_key" ON "Condition"("name");

-- AddForeignKey
ALTER TABLE "Avatar" ADD CONSTRAINT "Avatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exit" ADD CONSTRAINT "Exit_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exit" ADD CONSTRAINT "Exit_regionId_fromLocationId_fkey" FOREIGN KEY ("regionId", "fromLocationId") REFERENCES "Location"("regionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectInstance" ADD CONSTRAINT "ObjectInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ObjectTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionLog" ADD CONSTRAINT "PermissionLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
