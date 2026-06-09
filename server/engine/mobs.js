// Mob AI + world-scripts maintenance task.
// Register emitOnTick via registerMaintenanceTask('world-scripts', emitOnTick).
// Register mobKillHandler via registerSystemHandler('on_kill', mobKillHandler).
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { applyCondition, hasCondition } from './conditions.js';
import { runTrigger } from './statemachine.js';
import { logger } from '../log/logger.js';

// ─── Mob Redis helpers ────────────────────────────────────────────────────────

function mobKey(regionId, instanceId) {
  return `instance:${regionId ?? 'null'}:${instanceId}`;
}

async function loadMobState(regionId, instanceId) {
  const raw = await redis.get(mobKey(regionId, instanceId));
  return raw ? JSON.parse(raw) : null;
}

async function saveMobState(regionId, instanceId, mob) {
  await redis.set(mobKey(regionId, instanceId), JSON.stringify(mob));
  await markDirty('instance', `${regionId ?? 'null'}:${instanceId}`);
}

// ─── World-scripts maintenance task ──────────────────────────────────────────

const _noOutput = () => {};

export async function emitOnTick(currentTick, emit) {
  const regions = await db.region.findMany({ select: { id: true } });
  for (const region of regions) {
    const rId = region.id;

    // Fire on_tick for authored location scripts in this region
    const locs = await db.location.findMany({
      where: { regionId: rId },
      select: { id: true, scriptId: true },
    });
    for (const loc of locs) {
      if (!loc.scriptId) continue; // no script attached — skip DB round-trip
      await runTrigger('on_tick', { regionId: rId, locationId: loc.id, currentTick }, _noOutput, emit);
    }

    // Run direct mob AI for each live MOB instance in this region
    const mobInstances = await db.objectInstance.findMany({
      where: { regionId: rId },
      include: { template: { select: { type: true, baseSchema: true } } },
    });
    for (const inst of mobInstances) {
      if (inst.template?.type !== 'MOB') continue;
      await _runMobAiTick(inst, rId, currentTick, emit);
    }
  }
}

// ─── Mob AI tick ──────────────────────────────────────────────────────────────

async function _runMobAiTick(inst, regionId, currentTick, emit) {
  const mob = await loadMobState(regionId, inst.id);
  if (!mob) return;

  // Skip dead mobs
  if (hasCondition(mob, 'dead')) return;

  const aiStates = inst.template?.baseSchema?.aiStates;
  if (!aiStates) return;

  const currentState = mob.state?.currentAiState ?? inst.template?.baseSchema?.defaultState ?? 'idle';
  const stateConf = aiStates[currentState];
  if (!stateConf?.on_tick) return;

  const rule = stateConf.on_tick;

  // Condition check
  if (rule.condition === 'random_under') {
    if (Math.floor(Math.random() * 100) >= (rule.conditionValue ?? 20)) return;
  }

  // Execute action
  const action = rule.action;
  if (action === 'random_move') {
    await _mobRandomMove(inst, mob, regionId, currentTick, emit);
  } else if (action === 'patrol') {
    await _mobPatrolMove(inst, mob, regionId, currentTick, emit);
  }
}

async function _mobRandomMove(inst, mob, regionId, currentTick, emit) {
  const currentLocId = parseInt(mob.ownerId ?? inst.ownerId);
  const exits = await db.exit.findMany({ where: { regionId, fromLocationId: currentLocId } });
  const unlocked = exits.filter(e => !(e.isState?.locked));
  if (!unlocked.length) return;

  const exit = unlocked[Math.floor(Math.random() * unlocked.length)];
  const newLocId = exit.toLocationId;
  const newRegionId = exit.toRegionId ?? regionId;

  mob.ownerId = String(newLocId);
  if (newRegionId !== regionId) mob.regionId = newRegionId;

  await saveMobState(newRegionId, inst.id, mob);

  emit('instance', `${regionId}:${inst.id}`, 'on_move', {
    regionId, instanceId: inst.id, fromLocationId: currentLocId, toLocationId: newLocId,
  });

  logger.info('MOBS', 'mob_random_move', { instanceId: inst.id, from: currentLocId, to: newLocId });
}

async function _mobPatrolMove(inst, mob, regionId, currentTick, emit) {
  const patrolPath = inst.template?.baseSchema?.patrolPath;
  if (!Array.isArray(patrolPath) || patrolPath.length === 0) return;

  mob.state = mob.state ?? {};
  const currentIdx = mob.state.patrolIndex ?? 0;
  const nextIdx = (currentIdx + 1) % patrolPath.length;
  const nextLocId = patrolPath[nextIdx];

  mob.state.patrolIndex = nextIdx;
  mob.ownerId = String(nextLocId);

  await saveMobState(regionId, inst.id, mob);

  emit('instance', `${regionId}:${inst.id}`, 'on_move', {
    regionId, instanceId: inst.id,
    fromLocationId: patrolPath[currentIdx], toLocationId: nextLocId,
  });

  logger.info('MOBS', 'mob_patrol_move', { instanceId: inst.id, to: nextLocId, patrolIndex: nextIdx });
}

// ─── Mob kill handler (Response phase, event 'on_kill' for instances) ────────

export const mobKillHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    // on_kill fires for both avatar (entityType='avatar') and mob (entityType='instance')
    if ((ctx.targetType ?? ctx.entityType) !== 'instance') return;

    const rawId = ctx.targetId ?? ctx.entityId ?? '';
    const parts = String(rawId).split(':');
    const regionId = parseInt(parts[0]);
    const instanceId = parseInt(parts[1] ?? parts[0]);

    if (isNaN(regionId) || isNaN(instanceId)) return;

    // Apply dead condition
    const applied = await applyCondition('instance', `${regionId}:${instanceId}`, 'dead', null, tick);
    if (!applied) return;

    // Emit on_death for region respawn scripts
    const mob = await loadMobState(regionId, instanceId);
    if (!mob) return;

    const locationId = parseInt(mob.ownerId ?? '0');
    emit('location', `${regionId}:${locationId}`, 'on_death', {
      regionId, locationId, instanceId, regionIdOfInstance: regionId,
    });

    logger.info('MOBS', 'mob_killed', { instanceId, regionId, locationId });
  },
};
