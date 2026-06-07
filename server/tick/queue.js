// Action queue helpers — thin wrappers used by Phase 2 to enqueue typed actions.
import { redis } from '../db/redis.js';

export async function enqueueAction(action) {
  await redis.rPush('action:queue', JSON.stringify(action));
}

export async function queueLength() {
  return redis.lLen('action:queue');
}
