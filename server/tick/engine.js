// Runs in a worker thread. Receives messages from main thread, processes tick, sends output.
import { workerData, parentPort } from 'worker_threads';
import { config } from '../config.js';
import { initRedis, redis } from '../db/redis.js';
import { initDb, db } from '../db/postgres.js';
import { flushDirtyState } from '../db/sync.js';
import { runTrigger } from '../engine/statemachine.js';
import { resolve } from '../engine/resolver.js';
import { orderPhase } from '../engine/resolution.js';
import { runMaintenance, registerMaintenanceTask } from './maintenance.js';
import { tickConditions } from '../engine/conditions.js';
import { navigationHandler } from '../engine/navigation.js';
import { communicationHandler } from '../engine/communication.js';
import { inventoryHandler } from '../engine/inventory.js';
import { survivalTick } from '../engine/survival.js';
import { combatHandler, conditionExpireHandler } from '../engine/combat.js';
import { drainPhase, enqueueAction } from './queue.js';
import { logger } from '../log/logger.js';

export { enqueueAction };

let tickCount = 0;
let expectedTime = Date.now();

// Phase 2 system dispatch map: trigger/category → { roll(action), apply(action, result, emit, tick) }
// Each Phase 2 system registers one entry. Engine dispatches here before falling back to runTrigger.
const SYSTEM_HANDLERS = new Map();

export function registerSystemHandler(key, handler) {
  SYSTEM_HANDLERS.set(key, handler);
}

async function resolveActionRoll(action) {
  const key = action.trigger ?? action.category;
  const handler = SYSTEM_HANDLERS.get(key);
  if (handler?.roll) return handler.roll(action);
  // Default: ungated roll (orders the action; does not gate it)
  return resolve(action.sessionToken, null);
}

async function applyAction(action, result, emit, tick) {
  const sendOutput = (tokens, html) => parentPort.postMessage({ type: 'OUTPUT_MULTI', tokens, html });
  const key = action.trigger ?? action.category;
  const handler = SYSTEM_HANDLERS.get(key);
  if (handler?.apply) return handler.apply(action, result, emit, tick, sendOutput);
  // Default fallback: run as trigger through the state machine (Phase 1 behavior)
  if (action.trigger) {
    await runTrigger(
      action.trigger,
      { ...action.context, currentTick: tick },
      sendOutput,
      emit,
    );
  }
}

async function init() {
  await initDb();
  await initRedis();

  // Register Phase 2 maintenance tasks (executed in registration order each tick).
  // Maintenance tasks run in the worker thread; register here, not in index.js.
  registerMaintenanceTask('conditions', tickConditions);
  registerMaintenanceTask('survival', survivalTick);
  // 'world-scripts' registered by TASK 12 — import emitOnTick from '../engine/mobs.js'

  // Register Phase 2 system handlers (worker-thread dispatch for phase actions).
  registerSystemHandler('movement', navigationHandler);
  registerSystemHandler('communication', communicationHandler);
  registerSystemHandler('inventory', inventoryHandler);
  registerSystemHandler('combat', combatHandler);
  registerSystemHandler('on_condition_expire', conditionExpireHandler);

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

async function processTick() {
  const start = Date.now();
  expectedTime += config.tickMs;
  tickCount++;

  try {
    // emit accumulates in-tick events for same-tick Response processing (phase 4)
    const inTickEvents = [];
    const emit = (entityType, entityId, eventName, data = {}) =>
      inTickEvents.push({ entityType, entityId, eventName, data });

    // Phases 1–3: Movement, Communication, Action
    for (const phase of [1, 2, 3]) {
      const actions = await drainPhase(phase);
      if (actions.length === 0) continue;
      const ordered = await orderPhase(actions, (a) => resolveActionRoll(a));
      for (const { action, result } of ordered) {
        await applyAction(action, result, emit, tickCount);
      }
    }

    // Phase 4: Response — drain in-tick events through the state machine, same tick.
    // New events emitted by responses are appended; loop until empty (budget-capped).
    const sendOutput = (tokens, html) => parentPort.postMessage({ type: 'OUTPUT_MULTI', tokens, html });
    let guard = 0;
    while (inTickEvents.length && guard++ < config.maxResponseEventsPerTick) {
      const ev = inTickEvents.shift();
      const evContext = { ...ev.data, targetType: ev.entityType, targetId: ev.entityId, currentTick: tickCount };
      const responseHandler = SYSTEM_HANDLERS.get(ev.eventName);
      if (responseHandler?.apply) {
        await responseHandler.apply({ context: evContext }, {}, emit, tickCount, sendOutput);
      } else {
        await runTrigger(ev.eventName, evContext, sendOutput, emit);
      }
    }

    // Phase 5: Maintenance
    await runMaintenance(tickCount, emit);

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
