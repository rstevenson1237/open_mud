import { createClient } from 'redis';
import { logger } from '../log/logger.js';

export const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });

redis.on('error', (e) => logger.error('REDIS', 'Redis error', { message: e.message }));

export async function initRedis() {
  await redis.connect();
  logger.info('REDIS', 'Redis connected');
}

// Key conventions:
// avatar:{id}                        → avatar hot state JSON
// location:{regionId}:{locationId}:contents → Set of "ownerType:ownerId" strings
// mob:{regionId}:{instanceId}        → mob hot state JSON
// session:{token}                    → { userId, avatarId, connectedAt, graceTick }
// world:tickCount                    → current tick as string integer
// world:clock:{regionId}             → { tick, dayTick, cycleLength }
