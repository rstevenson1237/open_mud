import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { hasCondition, getStatModifier, applyCondition, removeCondition } from './conditions.js';
import { resolve } from './resolver.js';
import { allocateInstanceId } from './idAllocator.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

/**
 * Run all scripts attached to entities in a location for a given trigger event.
 *
 * @param {string} trigger         e.g. 'on_enter'
 * @param {object} context         { locationId, regionId, actorAvatarId?, actorSessionToken?,
 *                                   targetType?, targetId?, data: {} }
 * @param {Function} emitOutput    function(sessionTokens[], outputHtml)
 * @param {Function} emitEvent     function(entityType, entityId, eventName, data)
 */
export async function runTrigger(trigger, context, emitOutput, emitEvent) {
  const entries = await _loadScriptsForContext(context);

  for (const entry of entries) {
    const script = entry.script;
    // Each script runs under a context that knows which entity owns it,
    // so is_state/set_state resolve against the owner (instance, location, region)
    // rather than defaulting to the actor avatar. actorAvatarId is preserved.
    const scriptContext = { ...context, ...entry.target };

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

      const conditionsMet = await _evalConditions(rule.conditions, scriptContext, vars);
      if (!conditionsMet) continue;

      budget.transitions--;
      await _execActions(rule.actions, scriptContext, vars, budget, emitOutput, emitEvent, script.id, subroutines);
    }
  }
}

// Returns [{ script, target }] where target augments the context for each script:
//   location script → { targetType: 'location', targetId: '${regionId}:${locationId}' }
//   instance script → { targetType: 'instance', targetId: '${regionId}:${instanceId}' }
// This lets is_state/set_state resolve against the owning entity, not the actor.
async function _loadScriptsForContext(context) {
  const entries = [];

  if (context.regionId != null && context.locationId != null) {
    const loc = await db.location.findUnique({
      where: { regionId_id: { regionId: context.regionId, id: context.locationId } },
      select: { scriptId: true },
    });
    if (loc?.scriptId) {
      const s = await db.script.findUnique({ where: { id: loc.scriptId } });
      if (s) entries.push({
        script: s,
        target: { targetType: 'location', targetId: `${context.regionId}:${context.locationId}` },
      });
    }

    const instances = await db.objectInstance.findMany({
      where: { regionId: context.regionId, ownerType: 'LOCATION', ownerId: String(context.locationId) },
      select: { id: true, regionId: true, templateId: true },
    });
    for (const inst of instances) {
      const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { scriptId: true } });
      if (tmpl?.scriptId) {
        const s = await db.script.findUnique({ where: { id: tmpl.scriptId } });
        if (s) entries.push({
          script: s,
          target: { targetType: 'instance', targetId: `${inst.regionId ?? 'null'}:${inst.id}` },
        });
      }
    }
  }

  return entries;
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
    case 'user_type_is': {
      return context.actorUserType === cond.args[0];
    }
    case 'has_item': {
      const templateId = parseInt(cond.args[0]);
      if (!context.actorAvatarId) return false;
      const item = await db.objectInstance.findFirst({
        where: { templateId, ownerType: 'AVATAR', ownerId: String(context.actorAvatarId) },
      });
      return item !== null;
    }
    case 'has_visited': {
      // has_visited(regionId) — true if regionId is in avatar.visitedRegions
      const entity = await _loadEntity(context);
      const visited = entity?.visitedRegions ?? [];
      return visited.includes(parseInt(cond.args[0]));
    }
    default:
      logger.warn('STATE_MACHINE', 'Unknown condition function', { fn: cond.fn });
      return false;
  }
}

async function _execActions(actions, context, vars, budget, emitOutput, emitEvent, scriptId, subroutines = {}) {
  for (const action of actions) {
    // Substitute sigil args before dispatch
    const resolvedArgs = _substituteArgs(action.args ?? [], context);
    const resolvedAction = { ...action, args: resolvedArgs };

    logger.audit('STATE_MACHINE', 'action_exec', { scriptId, fn: resolvedAction.fn, args: resolvedAction.args });

    switch (resolvedAction.fn) {
      case 'say': {
        const [text] = resolvedAction.args;
        emitOutput(context.locationSessionTokens ?? [], `<span class="say">${_sanitize(text)}</span>`);
        break;
      }
      case 'set_state': {
        const [key, value] = resolvedAction.args;
        const entity = await _loadEntity(context);
        if (entity) {
          entity.isState = entity.isState ?? {};
          entity.isState[key] = value === 'true' ? true : value === 'false' ? false : value;
          await _saveEntity(context, entity);
        }
        break;
      }
      case 'apply_condition': {
        const [condName, durStr] = resolvedAction.args;
        const dur = durStr ? parseInt(durStr) : null;
        await applyCondition('avatar', context.actorAvatarId, condName, dur, context.currentTick);
        if (budget.events > 0) {
          budget.events--;
          await emitEvent('avatar', context.actorAvatarId, 'on_condition_apply', { conditionName: condName });
        }
        break;
      }
      case 'remove_condition': {
        await removeCondition('avatar', context.actorAvatarId, resolvedAction.args[0]);
        break;
      }
      case 'emit_event': {
        if (budget.events <= 0) {
          logger.warn('STATE_MACHINE', 'Script budget exceeded (events)', { scriptId });
          break;
        }
        budget.events--;
        const [eventName, targetType, targetRef] = resolvedAction.args;
        await emitEvent(targetType ?? 'avatar', targetRef ?? context.actorAvatarId, eventName, context);
        break;
      }
      case 'set_var': {
        const [name, value] = resolvedAction.args;
        vars[name] = value;
        break;
      }
      case 'create_instance': {
        // create_instance(templateId, locationId [, count])
        const [tplArg, locArg, countArg] = resolvedAction.args;
        const templateId = parseInt(tplArg);
        const regionId = context.regionId ?? null;
        const locationId = parseInt(locArg ?? context.locationId);
        const count = countArg ? parseInt(countArg) : 1;
        const tmpl = await db.objectTemplate.findUnique({ where: { id: templateId } });
        if (!tmpl) {
          logger.warn('STATE_MACHINE', 'create_instance: unknown template', { templateId });
          break;
        }
        const newId = await allocateInstanceId(regionId);
        await db.objectInstance.create({
          data: {
            id: newId, regionId, templateId,
            ownerType: 'LOCATION', ownerId: String(locationId),
            state: {}, isState: {},
            count: tmpl.type === 'COIN' ? count : null,
            metadata: {},
          },
        });
        logger.info('STATE_MACHINE', 'create_instance', { templateId, regionId, locationId, newId });
        break;
      }
      case 'destroy_instance': {
        // destroy_instance(instanceId [, regionId])
        const [idArg, regionArg] = resolvedAction.args;
        const instanceId = parseInt(idArg);
        const regionId = regionArg != null ? parseInt(regionArg) : (context.regionId ?? null);
        try {
          if (regionId == null) {
            const inst = await db.objectInstance.findFirst({ where: { regionId: null, id: instanceId } });
            if (inst) await db.objectInstance.delete({ where: { pk: inst.pk } });
          } else {
            await db.objectInstance.delete({ where: { regionId_id: { regionId, id: instanceId } } });
          }
          await redis.del(`instance:${regionId ?? 'null'}:${instanceId}`);
          await redis.sRem('dirty:instances', `${regionId ?? 'null'}:${instanceId}`);
          logger.info('STATE_MACHINE', 'destroy_instance', { instanceId, regionId });
        } catch (e) {
          logger.warn('STATE_MACHINE', 'destroy_instance failed', { instanceId, regionId, error: e.message });
        }
        break;
      }
      case 'call': {
        const [subName] = resolvedAction.args;
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
        logger.warn('STATE_MACHINE', 'Unimplemented action (stub)', { fn: resolvedAction.fn, scriptId });
    }
  }
}

/**
 * Substitute sigil args from context before dispatch.
 * $attacker → context.attackerAvatarId
 * $target   → context.targetId
 * #<id>     → stays as literal id string
 * @<name>   → best-effort: context.actorAvatarId if name matches, else left as-is
 */
function _substituteArgs(args, context) {
  return args.map(arg => {
    if (typeof arg !== 'string') return arg;
    if (arg === '$attacker') return String(context.attackerAvatarId ?? arg);
    if (arg === '$target')   return String(context.targetId ?? arg);
    if (arg === '$actor')    return String(context.actorAvatarId ?? arg);
    // #<id> — keep as-is (literal id already resolved at parse time)
    return arg;
  });
}

/**
 * Load the entity a script action should operate on.
 * Resolution order:
 *  1. targetType='instance' → Redis instance hot-state
 *  2. targetType is structural (location/exit/region) → DB load
 *  3. Default → actor avatar from Redis
 */
async function _loadEntity(context) {
  if (context.targetType === 'instance' && context.targetId != null) {
    const raw = await redis.get(`instance:${context.targetId}`);
    return raw ? JSON.parse(raw) : null;
  }
  if (context.targetType && context.targetType !== 'avatar' && context.targetId != null) {
    return await _loadStructural(context.targetType, context.targetId);
  }
  if (context.actorAvatarId) {
    const raw = await redis.get(`avatar:${context.actorAvatarId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return null;
}

/**
 * Save the entity a script action operated on.
 * Mirrors _loadEntity resolution order.
 */
async function _saveEntity(context, entity) {
  if (context.targetType === 'instance' && context.targetId != null) {
    await redis.set(`instance:${context.targetId}`, JSON.stringify(entity));
    const { markDirty } = await import('../db/sync.js');
    await markDirty('instance', context.targetId);
    return;
  }
  if (context.targetType && context.targetType !== 'avatar' && context.targetId != null) {
    await _saveStructural(context.targetType, context.targetId, entity);
    return;
  }
  if (context.actorAvatarId) {
    await redis.set(`avatar:${context.actorAvatarId}`, JSON.stringify(entity));
    const { markDirty } = await import('../db/sync.js');
    await markDirty('avatar', context.actorAvatarId);
  }
}

/**
 * Load a structural entity (location, exit, region) from Postgres.
 * Structural entities are not kept in Redis hot-state in Phase 1.
 * targetId format: "regionId:localId" for location/exit, or just "id" for region.
 */
async function _loadStructural(type, targetId) {
  const parts = String(targetId).split(':');
  if (type === 'location' && parts.length >= 2) {
    return await db.location.findUnique({
      where: { regionId_id: { regionId: parseInt(parts[0]), id: parseInt(parts[1]) } },
    });
  }
  if (type === 'exit' && parts.length >= 2) {
    return await db.exit.findUnique({
      where: { regionId_id: { regionId: parseInt(parts[0]), id: parseInt(parts[1]) } },
    });
  }
  if (type === 'region') {
    return await db.region.findUnique({ where: { id: parseInt(parts[0]) } });
  }
  return null;
}

// Fields that DSL scripts may write on structural entities.
// config is builder-only and is intentionally excluded.
const LOCATION_WRITABLE = ['isState', 'description', 'name'];
const EXIT_WRITABLE = ['isState'];

function pickStructural(obj, cols) {
  return Object.fromEntries(cols.filter(c => c in obj).map(c => [c, obj[c]]));
}

async function _saveStructural(type, targetId, entity) {
  const parts = String(targetId).split(':');
  if (type === 'location' && parts.length >= 2) {
    await db.location.update({
      where: { regionId_id: { regionId: parseInt(parts[0]), id: parseInt(parts[1]) } },
      data: pickStructural(entity, LOCATION_WRITABLE),
    });
    return;
  }
  if (type === 'exit' && parts.length >= 2) {
    await db.exit.update({
      where: { regionId_id: { regionId: parseInt(parts[0]), id: parseInt(parts[1]) } },
      data: pickStructural(entity, EXIT_WRITABLE),
    });
    return;
  }
  // region: scripts may not mutate region rows (builder-only). Log and skip.
  logger.warn('STATE_MACHINE', 'Structural save skipped (not script-writable)', { type, targetId });
}

function _sanitize(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
