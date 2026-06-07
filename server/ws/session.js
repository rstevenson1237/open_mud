// Session state helpers — read/write session data in Redis.
import { redis } from '../db/redis.js';
import { config } from '../config.js';

export async function getSession(token) {
  const raw = await redis.get(`session:${token}`);
  return raw ? JSON.parse(raw) : null;
}

export async function updateSession(token, patch) {
  const session = await getSession(token);
  if (!session) return false;
  await redis.set(`session:${token}`, JSON.stringify({ ...session, ...patch }));
  return true;
}

export async function destroySession(token) {
  await redis.del(`session:${token}`);
}

// Called by tick engine to expire ghost sessions that outlived their grace period.
export async function expireGhostSessions(currentTick) {
  // Phase 2 implements full ghost fallback logic.
  // Phase 1: sessions with graceTick <= currentTick are considered expired.
}
