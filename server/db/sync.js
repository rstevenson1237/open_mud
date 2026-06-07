import { db } from './postgres.js';
import { redis } from './redis.js';
import { logger } from '../log/logger.js';

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
      await db.avatar.update({ where: { id: parseInt(avatarId) }, data: state });
      await redis.sRem('dirty:avatars', avatarId);
    } catch (e) {
      logger.error('SYNC', 'Avatar flush failed', { avatarId, error: e.message });
    }
  }

  for (const key of dirtyInstances) {
    const [regionId, instanceId] = key.split(':');
    const raw = await redis.get(`instance:${regionId}:${instanceId}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    try {
      await db.objectInstance.update({
        where: { regionId_id: { regionId: parseInt(regionId), id: parseInt(instanceId) } },
        data: state,
      });
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
  if (type === 'instance') await redis.sAdd('dirty:instances', id); // "regionId:instanceId"
}
