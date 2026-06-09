// Action queue helpers — shared between main thread (router) and worker thread (tick engine).
// Both import this module and write to Redis phase queues. The tick engine reads from Redis.
// Key format: action:queue:{phase}  (phases 1–5)
import { redis } from '../db/redis.js';

export async function enqueueAction(action) {
  const phase = action.phase ?? 3;
  await redis.rPush(`action:queue:${phase}`, JSON.stringify({ ...action, phase }));
}

export async function drainPhase(phase) {
  const key = `action:queue:${phase}`;
  const raw = await redis.lRange(key, 0, -1);
  await redis.del(key);
  return raw.map(r => JSON.parse(r));
}

export async function queueLength(phase) {
  if (phase) return redis.lLen(`action:queue:${phase}`);
  let total = 0;
  for (let p = 1; p <= 5; p++) total += await redis.lLen(`action:queue:${p}`);
  return total;
}
