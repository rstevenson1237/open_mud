import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';

/**
 * Apply a condition to an entity (avatar or object instance).
 * No stacking — if the condition is already present, refresh duration only.
 *
 * @param {string} entityType  'avatar' | 'instance'
 * @param {string} entityId    avatarId or "regionId:instanceId"
 * @param {string} conditionName
 * @param {number|null} durationTicks  null = permanent
 * @param {number} currentTick
 */
export async function applyCondition(entityType, entityId, conditionName, durationTicks, currentTick) {
  const condDef = await db.condition.findUnique({ where: { name: conditionName } });
  if (!condDef) {
    logger.warn('CONDITIONS', 'Unknown condition', { conditionName });
    return false;
  }

  const key = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(key);
  if (!raw) return false;

  const entity = JSON.parse(raw);
  const conditions = entity.activeConditions ?? [];

  const existing = conditions.findIndex(c => c.name === conditionName);
  const entry = {
    name: conditionName,
    conditionId: condDef.id,
    appliedAt: currentTick,
    expiresAt: durationTicks !== null ? currentTick + durationTicks : null,
    modifier: condDef.modifier,
    affectedStat: condDef.affectedStat,
    visibilityEffect: condDef.visibilityEffect,
  };

  if (existing >= 0) {
    conditions[existing] = entry; // refresh, no stack
  } else {
    conditions.push(entry);
  }

  entity.activeConditions = conditions;
  await redis.set(key, JSON.stringify(entity));
  await markDirty(entityType, entityId);

  logger.audit('STATE_MACHINE', 'condition_applied', { entityType, entityId, conditionName, durationTicks });
  return true;
}

/**
 * Remove a named condition from an entity.
 */
export async function removeCondition(entityType, entityId, conditionName) {
  const key = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(key);
  if (!raw) return false;

  const entity = JSON.parse(raw);
  const before = entity.activeConditions?.length ?? 0;
  entity.activeConditions = (entity.activeConditions ?? []).filter(c => c.name !== conditionName);

  if (entity.activeConditions.length === before) return false;

  await redis.set(key, JSON.stringify(entity));
  await markDirty(entityType, entityId);

  logger.audit('STATE_MACHINE', 'condition_removed', { entityType, entityId, conditionName });
  return true;
}

/**
 * Tick all conditions — decrement durations, remove expired, fire expiry events.
 * Called once per tick by the maintenance task registered in index.js.
 *
 * @param {number} currentTick
 * @param {Function} emitEvent  function(entityType, entityId, eventName, data)
 */
export async function tickConditions(currentTick, emitEvent) {
  for (const pattern of ['avatar:*', 'instance:*']) {
    const keys = await redis.keys(pattern);
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const entity = JSON.parse(raw);
      const [type] = key.split(':');                        // 'avatar' | 'instance'
      const id = key.slice(key.indexOf(':') + 1);           // avatarId OR "regionId:instanceId"
      await _tickEntityConditions(entity, type, id, currentTick, emitEvent);
      await redis.set(key, JSON.stringify(entity));
    }
  }
}

async function _tickEntityConditions(entity, entityType, entityId, currentTick, emitEvent) {
  const conditions = entity.activeConditions ?? [];
  const expired = conditions.filter(c => c.expiresAt !== null && currentTick >= c.expiresAt);
  entity.activeConditions = conditions.filter(c => c.expiresAt === null || currentTick < c.expiresAt);

  for (const c of expired) {
    logger.audit('STATE_MACHINE', 'condition_expired', { entityType, entityId, conditionName: c.name });
    await emitEvent(entityType, entityId, 'on_condition_expire', { conditionName: c.name });
  }

  if (expired.length > 0) await markDirty(entityType, entityId);
}

/**
 * Check if an entity has a named condition active.
 */
export function hasCondition(entity, conditionName) {
  return (entity.activeConditions ?? []).some(c => c.name === conditionName);
}

/**
 * Get the net modifier for a stat from all active conditions.
 * affectedStat may be a comma-separated list (e.g. "phy_for,phy_pre").
 */
export function getStatModifier(entity, statName) {
  return (entity.activeConditions ?? [])
    .filter(c => c.affectedStat && c.affectedStat.split(',').map(s => s.trim()).includes(statName))
    .reduce((sum, c) => sum + (c.modifier ?? 0), 0);
}
