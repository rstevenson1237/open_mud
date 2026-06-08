import { db } from './postgres.js';
import { redis } from './redis.js';
import { logger } from '../log/logger.js';

// Whitelist of Avatar columns that are safe to write via update.
// Excludes: id (PK), userId (FK), createdAt, updatedAt (managed by Prisma).
// Extend this list as Phase 2 tasks add columns to the Avatar model.
const AVATAR_COLS = [
  'name', 'regionId', 'locationId', 'stats', 'skills',
  'wounds', 'sanity', 'woundMax', 'sanityMax',
  'stress', 'hunger', 'rest',
  'carryCapacity', 'encumberedThreshold',
  'activeConditions', 'aliases', 'visitedRegions',
  'isActive', 'disconnectedAt', 'metadata',
];

// Whitelist of ObjectInstance columns that are safe to write via update.
// Excludes: pk (PK auto), id (composite key), regionId (composite key),
//           templateId (immutable FK), createdAt, updatedAt.
const INSTANCE_COLS = [
  'ownerType', 'ownerId', 'state', 'isState',
  'activeConditions', 'count', 'metadata',
];

function pick(obj, cols) {
  return Object.fromEntries(cols.filter(c => c in obj).map(c => [c, obj[c]]));
}

// Called by tick engine every N ticks and on significant events.
// On crash: Postgres is source of truth. Redis has AOF for its own recovery.
// Never attempt partial reconciliation — recover to last known good Postgres state.
export async function flushDirtyState(tickCount) {
  const dirtyAvatars = await redis.sMembers('dirty:avatars');
  const dirtyInstances = await redis.sMembers('dirty:instances');

  for (const avatarId of dirtyAvatars) {
    const raw = await redis.get(`avatar:${avatarId}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    try {
      await db.avatar.update({
        where: { id: parseInt(avatarId) },
        data: pick(state, AVATAR_COLS),
      });
      await redis.sRem('dirty:avatars', avatarId);
    } catch (e) {
      logger.error('SYNC', 'Avatar flush failed', { avatarId, error: e.message });
    }
  }

  for (const key of dirtyInstances) {
    const colonIdx = key.indexOf(':');
    const r = key.slice(0, colonIdx);
    const i = key.slice(colonIdx + 1);
    const regionId = r === 'null' ? null : parseInt(r);
    const instanceId = parseInt(i);

    const raw = await redis.get(`instance:${key}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    const data = pick(state, INSTANCE_COLS);

    try {
      if (regionId === null) {
        // Null regionId: fall back to lookup by findFirst then update by pk
        const inst = await db.objectInstance.findFirst({ where: { regionId: null, id: instanceId } });
        if (inst) {
          await db.objectInstance.update({ where: { pk: inst.pk }, data });
        }
      } else {
        await db.objectInstance.update({
          where: { regionId_id: { regionId, id: instanceId } },
          data,
        });
      }
      await redis.sRem('dirty:instances', key);
    } catch (e) {
      logger.error('SYNC', 'Instance flush failed', { key, error: e.message });
    }
  }

  await db.worldState.update({
    where: { id: 1 },
    data: { tickCount: BigInt(tickCount), lastFlushAt: new Date() },
  });

  logger.info('SYNC', 'State flush complete', { tickCount, avatars: dirtyAvatars.length, instances: dirtyInstances.length });
}

// Mark entity as dirty — written to Redis immediately, flushed to Postgres on interval
export async function markDirty(type, id) {
  if (type === 'avatar')   await redis.sAdd('dirty:avatars', String(id));
  if (type === 'instance') await redis.sAdd('dirty:instances', String(id)); // "regionId:instanceId"
}
