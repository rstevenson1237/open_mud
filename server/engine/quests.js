// Quest engine — reactive objective evaluation and reward dispatch.
// questHook is called once per drained Response event in engine.js.
// Full implementation in Task 6; this stub is required by Task 0.4.
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';

// Placeholder until Task 6 implements the full quest engine.
export async function questHook(_eventName, _context, _tick, _emit, _sendOutput) {
  // no-op stub
}
