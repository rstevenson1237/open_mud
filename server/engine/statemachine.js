import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { hasCondition, getStatModifier, applyCondition, removeCondition } from './conditions.js';
import { resolve } from './resolver.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

/**
 * Run all scripts attached to entities in a location for a given trigger event.
 *
 * @param {string} trigger         e.g. 'on_enter'
 * @param {object} context         { locationId, regionId, actorAvatarId?, actorSessionToken?, data: {} }
 * @param {Function} emitOutput    function(sessionTokens[], outputHtml)
 * @param {Function} emitEvent     function(eventName, targetType, targetId, data)
 */
export async function runTrigger(trigger, context, emitOutput, emitEvent) {
  const scripts = await _loadScriptsForContext(context);

  for (const script of scripts) {
    const budget = {
      transitions: script.maxTransitions ?? config.scriptMaxTransitions,
      events: script.maxEvents ?? config.scriptMaxEvents,
    };
    const vars = {};

    // Support both old flat-array body and new { rules, subroutines } shape
    const body = Array.isArray(script.body) ? script.body : (script.body?.rules ?? []);
    const subroutines = Array.isArray(script.body) ? {} : (script.body?.subroutines ?? {});

    for (const rule of body) {
      if (rule.trigger !== trigger) continue;
      if (budget.transitions <= 0) {
        logger.warn('STATE_MACHINE', 'Script budget exceeded (transitions)', { scriptId: script.id });
        break;
      }

      const conditionsMet = await _evalConditions(rule.conditions, context, vars);
      if (!conditionsMet) continue;

      budget.transitions--;
      await _execActions(rule.actions, context, vars, budget, emitOutput, emitEvent, script.id, subroutines);
    }
  }
}

async function _loadScriptsForContext(context) {
  const scripts = [];

  const loc = await db.location.findUnique({
    where: { regionId_id: { regionId: context.regionId, id: context.locationId } },
    select: { scriptId: true },
  });
  if (loc?.scriptId) {
    const s = await db.script.findUnique({ where: { id: loc.scriptId } });
    if (s) scripts.push(s);
  }

  const instances = await db.objectInstance.findMany({
    where: { regionId: context.regionId, ownerType: 'LOCATION', ownerId: String(context.locationId) },
    select: { templateId: true },
  });
  for (const inst of instances) {
    const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { scriptId: true } });
    if (tmpl?.scriptId) {
      const s = await db.script.findUnique({ where: { id: tmpl.scriptId } });
      if (s) scripts.push(s);
    }
  }

  return scripts;
}

async function _evalConditions(conditions, context, vars) {
  for (const cond of conditions) {
    const result = await _evalCondition(cond, context, vars);
    if (!result) return false;
  }
  return true;
}

async function _evalCondition(cond, context, vars) {
  switch (cond.fn) {
    case 'is_state': {
      const [key, expectedRaw] = cond.args;
      const expected = expectedRaw === 'true' ? true : expectedRaw === 'false' ? false : expectedRaw;
      const entity = await _loadEntity(context);
      return entity?.isState?.[key] === expected;
    }
    case 'has_condition': {
      const entity = await _loadEntity(context);
      return entity ? hasCondition(entity, cond.args[0]) : false;
    }
    case 'in_state': {
      const entity = await _loadEntity(context);
      return entity?.state?.currentState === cond.args[0];
    }
    case 'stat_above': {
      const [statName, valueStr] = cond.args;
      const entity = await _loadEntity(context);
      const base = entity?.stats?.[statName]?.value ?? 0;
      const mod = entity ? getStatModifier(entity, statName) : 0;
      return (base + mod) > parseInt(valueStr);
    }
    case 'stat_below': {
      const [statName, valueStr] = cond.args;
      const entity = await _loadEntity(context);
      const base = entity?.stats?.[statName]?.value ?? 0;
      const mod = entity ? getStatModifier(entity, statName) : 0;
      return (base + mod) < parseInt(valueStr);
    }
    case 'random_under': {
      return Math.floor(Math.random() * 100) < parseInt(cond.args[0]);
    }
    case 'zone_is': {
      const loc = await db.location.findUnique({
        where: { regionId_id: { regionId: context.regionId, id: context.locationId } },
        select: { zoneType: true },
      });
      return loc?.zoneType === cond.args[0];
    }
    default:
      logger.warn('STATE_MACHINE', 'Unknown condition function', { fn: cond.fn });
      return false;
  }
}

async function _execActions(actions, context, vars, budget, emitOutput, emitEvent, scriptId, subroutines = {}) {
  for (const action of actions) {
    logger.audit('STATE_MACHINE', 'action_exec', { scriptId, fn: action.fn, args: action.args });

    switch (action.fn) {
      case 'say': {
        const [text] = action.args;
        emitOutput(context.locationSessionTokens ?? [], `<span class="say">${_sanitize(text)}</span>`);
        break;
      }
      case 'set_state': {
        const [key, value] = action.args;
        const entity = await _loadEntity(context);
        if (entity) {
          entity.isState = entity.isState ?? {};
          entity.isState[key] = value === 'true' ? true : value === 'false' ? false : value;
          await _saveEntity(context, entity);
        }
        break;
      }
      case 'apply_condition': {
        const [condName, durStr] = action.args;
        const dur = durStr ? parseInt(durStr) : null;
        await applyCondition('avatar', context.actorAvatarId, condName, dur, context.currentTick);
        if (budget.events > 0) {
          budget.events--;
          await emitEvent('on_condition_apply', 'avatar', context.actorAvatarId, { conditionName: condName });
        }
        break;
      }
      case 'remove_condition': {
        await removeCondition('avatar', context.actorAvatarId, action.args[0], context.currentTick);
        break;
      }
      case 'emit_event': {
        if (budget.events <= 0) {
          logger.warn('STATE_MACHINE', 'Script budget exceeded (events)', { scriptId });
          break;
        }
        budget.events--;
        const [eventName, targetRef] = action.args;
        await emitEvent(eventName, 'ref', targetRef, context);
        break;
      }
      case 'set_var': {
        const [name, value] = action.args;
        vars[name] = value;
        break;
      }
      case 'create_instance': {
        const [templateId, locationId] = action.args;
        logger.info('STATE_MACHINE', 'create_instance_stub', { templateId, locationId });
        break;
      }
      case 'destroy_instance': {
        const [instanceId] = action.args;
        logger.info('STATE_MACHINE', 'destroy_instance_stub', { instanceId });
        break;
      }
      case 'call': {
        const [subName] = action.args;
        const subRules = subroutines[subName];
        if (!subRules) {
          logger.warn('STATE_MACHINE', 'Unknown subroutine', { subName, scriptId });
          break;
        }
        for (const rule of subRules) {
          if (budget.transitions <= 0) {
            logger.warn('STATE_MACHINE', 'Script budget exceeded in subroutine', { scriptId, subName });
            break;
          }
          const condsMet = await _evalConditions(rule.conditions, context, vars);
          if (!condsMet) continue;
          budget.transitions--;
          await _execActions(rule.actions, context, vars, budget, emitOutput, emitEvent, scriptId, subroutines);
        }
        break;
      }
      default:
        logger.warn('STATE_MACHINE', 'Unimplemented action (stub)', { fn: action.fn, scriptId });
    }
  }
}

async function _loadEntity(context) {
  if (!context.actorAvatarId) return null;
  const raw = await redis.get(`avatar:${context.actorAvatarId}`);
  return raw ? JSON.parse(raw) : null;
}

async function _saveEntity(context, entity) {
  if (!context.actorAvatarId) return;
  await redis.set(`avatar:${context.actorAvatarId}`, JSON.stringify(entity));
  const { markDirty } = await import('../db/sync.js');
  await markDirty('avatar', context.actorAvatarId);
}

function _sanitize(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
