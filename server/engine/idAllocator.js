// Monotonic Redis-backed instance ID allocator for tick-time spawns.
// All tick-time object creation (crafting, loot, quest rewards, resource respawn)
// uses allocateInstanceId to avoid races under concurrent spawns within a tick.
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';

const counterKey = (regionId) => `world:nextInstanceId:${regionId ?? 'null'}`;

async function ensureSeeded(regionId) {
  const key = counterKey(regionId);
  if (await redis.exists(key)) return;
  const row = regionId == null
    ? await db.objectInstance.findFirst({ where: { regionId: null }, orderBy: { id: 'desc' }, select: { id: true } })
    : await db.objectInstance.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
  // NX: only set if the key is still absent, in case of concurrent seeds
  await redis.set(key, String(row?.id ?? 0), { NX: true });
}

export async function allocateInstanceId(regionId) {
  await ensureSeeded(regionId ?? null);
  return redis.incr(counterKey(regionId ?? null));
}
