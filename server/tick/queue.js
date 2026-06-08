// Action queue helpers — shared between main thread (router) and worker thread (tick engine).
// Both import this module and write to Redis phase queues. The tick engine reads from Redis.
import { redis } from '../db/redis.js';

export async function enqueueAction(action) {
  const phase = action.phase ?? 3;
  await redis.rPush(`action:queue:phase${phase}`, JSON.stringify(action));
}

export async function queueLength(phase) {
  if (phase) return redis.lLen(`action:queue:phase${phase}`);
  let total = 0;
  for (let p = 1; p <= 4; p++) total += await redis.lLen(`action:queue:phase${p}`);
  return total;
}
