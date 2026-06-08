// Runs in a worker thread. Receives messages from main thread, processes tick, sends output.
import { workerData, parentPort } from 'worker_threads';
import { config } from '../config.js';
import { initRedis, redis } from '../db/redis.js';
import { initDb, db } from '../db/postgres.js';
import { flushDirtyState } from '../db/sync.js';
import { tickConditions } from '../engine/conditions.js';
import { runTrigger } from '../engine/statemachine.js';
import { logger } from '../log/logger.js';
import { enqueueAction } from './queue.js';

export { enqueueAction };

let tickCount = 0;
let expectedTime = Date.now();

async function init() {
  await initDb();
  await initRedis();
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  tickCount = Number(world?.tickCount ?? 0n);
  logger.info('TICK', 'Tick engine initialized', { tickCount });
  scheduleTick();
}

function scheduleTick() {
  const now = Date.now();
  const delay = Math.max(0, expectedTime - now);
  setTimeout(processTick, delay);
}

async function drainPhaseQueue(phase) {
  const key = `action:queue:phase${phase}`;
  const raw = await redis.lRange(key, 0, -1);
  await redis.del(key);
  return raw.map(r => JSON.parse(r));
}

// Priority: combat(4) > movement(3) > inventory(2) > communication(1) > other(0)
const PRIORITY = { combat: 4, movement: 3, inventory: 2, communication: 1 };

function arbitrate(actions) {
  const byResource = {};
  for (const action of actions) {
    const key = action.resourceKey ?? 'none';
    if (!byResource[key]) byResource[key] = [];
    byResource[key].push(action);
  }

  const resolved = [];
  for (const [resource, group] of Object.entries(byResource)) {
    if (group.length === 1) { resolved.push(group[0]); continue; }
    group.sort((a, b) => {
      const pa = PRIORITY[a.category] ?? 0;
      const pb = PRIORITY[b.category] ?? 0;
      if (pa !== pb) return pb - pa;
      return Math.random() - 0.5;
    });
    resolved.push(group[0]);
    for (const loser of group.slice(1)) {
      logger.info('TICK', 'Action conflict resolved', { resource, winner: group[0].id, loser: loser.id });
      parentPort.postMessage({ type: 'OUTPUT', sessionToken: loser.sessionToken, html: '<span class="system">Your action was interrupted.</span>' });
    }
  }
  return resolved;
}

async function processAction(action, currentPhase) {
  await runTrigger(
    action.trigger,
    { ...action.context, currentTick: tickCount, _currentPhase: currentPhase },
    (tokens, html) => parentPort.postMessage({ type: 'OUTPUT_MULTI', tokens, html }),
    (eventName, targetType, targetId, data, targetPhase) =>
      emitEventToPhase(eventName, targetType, targetId, data, targetPhase, currentPhase),
  );
}

// Phase-aware event emitter. Events targeting an earlier phase defer to next tick's phase 4.
async function emitEventToPhase(eventName, targetType, targetId, data, targetPhase = 4, currentPhase = 4) {
  const resolvedPhase = targetPhase < currentPhase ? 4 : targetPhase;
  await enqueueAction({
    phase: resolvedPhase,
    trigger: eventName,
    category: 'other',
    resourceKey: `${targetType}:${targetId}`,
    context: { ...data, targetType, targetId, _currentPhase: resolvedPhase },
  });
}

async function processTick() {
  const start = Date.now();
  expectedTime += config.tickMs;
  tickCount++;

  try {
    // Process four phases sequentially
    for (let phase = 1; phase <= 4; phase++) {
      const actions = await drainPhaseQueue(phase);
      const resolved = arbitrate(actions);
      for (const action of resolved) {
        await processAction(action, phase);
      }
    }

    // Tick conditions (after all phases)
    await tickConditions(tickCount, (name, type, id, data) => emitEventToPhase(name, type, id, data, 4, 4));

    // Tick world clocks
    await tickClocks();

    // Flush to Postgres every N ticks
    if (tickCount % config.dbFlushIntervalTicks === 0) {
      await flushDirtyState(tickCount);
    }

    await redis.set('world:tickCount', String(tickCount));

    const elapsed = Date.now() - start;
    if (elapsed > config.tickDriftWarnMs) {
      logger.warn('TICK', 'Tick drift detected', { tickCount, elapsedMs: elapsed, limitMs: config.tickDriftWarnMs });
      parentPort.postMessage({ type: 'ADMIN_ALERT', message: `Tick ${tickCount} took ${elapsed}ms (limit ${config.tickDriftWarnMs}ms)` });
    }

  } catch (e) {
    logger.error('TICK', 'Tick error', { tickCount, error: e.message, stack: e.stack });
  }

  scheduleTick();
}

async function tickClocks() {
  const regions = await db.region.findMany({ select: { id: true, config: true } });
  for (const region of regions) {
    const cycle = region.config?.dayNightCycleTicks ?? config.defaultWorldDayTicks;
    const dayTick = tickCount % cycle;
    await redis.set(`world:clock:${region.id}`, JSON.stringify({ tick: tickCount, dayTick, cycleLength: cycle }));
  }
}

init();
