// World clock helpers — read current clock state for a region from Redis.
import { redis } from '../db/redis.js';

export async function getRegionClock(regionId) {
  const raw = await redis.get(`world:clock:${regionId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function getWorldTick() {
  const val = await redis.get('world:tickCount');
  return val ? parseInt(val) : 0;
}
