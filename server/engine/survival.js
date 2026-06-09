// Survival maintenance task. Register via registerMaintenanceTask('survival', survivalTick).
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { applyCondition, removeCondition, hasCondition } from './conditions.js';
import { logger } from '../log/logger.js';

// Wound chain: level → required conditions (cumulative)
const WOUND_CHAIN = {
  1: ['wounded_1'],
  2: ['wounded_1', 'wounded_2'],
  3: ['wounded_1', 'wounded_2', 'wounded_3', 'dying'],
};
const WOUND_COND_NAMES = ['wounded_1', 'wounded_2', 'wounded_3', 'dying'];

// Sanity chain
const SANITY_CHAIN = {
  1: ['shaken_1'],
  2: ['shaken_1', 'shaken_2'],
  3: ['shaken_1', 'shaken_2', 'shaken_3', 'broken'],
};
const SANITY_COND_NAMES = ['shaken_1', 'shaken_2', 'shaken_3', 'broken'];

// Duration for timed chain caps
const DYING_TICKS  = 10;
const BROKEN_TICKS = 10;
const PANIC_TICKS  = 10;

export async function survivalTick(currentTick, emit) {
  await _drainStressPending(currentTick);
  await _reconcileAllChains(currentTick, emit);
}

// ---------------------------------------------------------------------------
// Stress
// ---------------------------------------------------------------------------

async function _drainStressPending(currentTick) {
  const items = await redis.lRange('stress:pending', 0, -1);
  if (!items.length) return;
  await redis.del('stress:pending');

  const increments = {};
  for (const raw of items) {
    try {
      const { avatarId, amount } = JSON.parse(raw);
      increments[String(avatarId)] = (increments[String(avatarId)] ?? 0) + (amount ?? 1);
    } catch { /* skip malformed */ }
  }

  for (const [avatarId, delta] of Object.entries(increments)) {
    const avRaw = await redis.get(`avatar:${avatarId}`);
    if (!avRaw) continue;
    const avatar = JSON.parse(avRaw);

    const newStress = Math.min(20, Math.max(1, (avatar.stress ?? 1) + delta));
    avatar.stress = newStress;
    await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
    await markDirty('avatar', avatarId);

    if (newStress >= 20) {
      await applyCondition('avatar', avatarId, 'overwhelmed', null,     currentTick);
      await applyCondition('avatar', avatarId, 'panic',       PANIC_TICKS, currentTick);
      logger.info('SURVIVAL', 'stress_peak', { avatarId, stress: newStress });
    }
  }
}

// ---------------------------------------------------------------------------
// Chain reconciliation
// ---------------------------------------------------------------------------

async function _reconcileAllChains(currentTick, emit) {
  const keys = await redis.keys('avatar:*');
  for (const key of keys) {
    const avRaw = await redis.get(key);
    if (!avRaw) continue;
    const avatar = JSON.parse(avRaw);
    if (!avatar.id || !avatar.isActive) continue;

    const avatarId = avatar.id;
    const woundLevel = Math.min(avatar.wounds ?? 0, avatar.woundMax ?? 3);
    const sanityLevel = Math.min(avatar.sanity ?? 0, avatar.sanityMax ?? 3);

    await _reconcileChain(
      avatarId, woundLevel, WOUND_CHAIN, WOUND_COND_NAMES, currentTick,
      DYING_TICKS, 'dying',
    );
    await _reconcileChain(
      avatarId, sanityLevel, SANITY_CHAIN, SANITY_COND_NAMES, currentTick,
      BROKEN_TICKS, 'broken',
    );
  }
}

async function _reconcileChain(avatarId, level, chainMap, allNames, currentTick, capDuration, capName) {
  // Reload fresh to see any changes from prior applyCondition/removeCondition calls
  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return;
  const avatar = JSON.parse(avRaw);

  const required = level > 0 ? (chainMap[level] ?? []) : [];

  // Apply missing required conditions (don't refresh already-present ones)
  for (const condName of required) {
    if (!hasCondition(avatar, condName)) {
      const dur = condName === capName ? capDuration : null;
      await applyCondition('avatar', avatarId, condName, dur, currentTick);
    }
  }

  // Remove conditions present but no longer required
  for (const condName of allNames) {
    if (!required.includes(condName) && hasCondition(avatar, condName)) {
      await removeCondition('avatar', avatarId, condName);
    }
  }
}
