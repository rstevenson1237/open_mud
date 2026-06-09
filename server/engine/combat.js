// Combat system handler (worker-thread phase 3 for attack; Response phase for death).
// DSL vocab .add() calls deferred to TASK 13 (parser.js VALID_ Sets not exported).
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { applyCondition, removeCondition, hasCondition } from './conditions.js';
import { resolve, resolveOpposed } from './resolver.js';
import { getRollTarget } from './stats.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── Instance hot-state helpers ──────────────────────────────────────────────

function mobKey(regionId, instanceId) { return `instance:${regionId ?? 'null'}:${instanceId}`; }

async function loadMob(regionId, instanceId) {
  const raw = await redis.get(mobKey(regionId, instanceId));
  if (raw) return JSON.parse(raw);
  const inst = await db.objectInstance.findFirst({
    where: { regionId, id: instanceId },
    include: { template: { select: { id: true, name: true, baseSchema: true, lootTable: true } } },
  });
  return inst;
}

async function saveMob(regionId, instanceId, inst) {
  await redis.set(mobKey(regionId, instanceId), JSON.stringify(inst));
  await markDirty('instance', `${regionId ?? 'null'}:${instanceId}`);
}

// ─── Armor helpers ───────────────────────────────────────────────────────────

async function getEquippedArmor(avatarId) {
  const instances = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { type: true, baseSchema: true } } },
  });
  return instances.find(i =>
    i.template.type === 'ARMOR' && i.isState?.equipped && !hasCondition(i, 'armor_broken')
  ) ?? null;
}

async function decrementArmorDurability(armor, currentTick, sendOutput) {
  const maxDur = armor.template?.baseSchema?.durability ?? 5;
  const curDur = armor.state?.durability ?? maxDur;
  const newDur = curDur - 1;

  armor.state = armor.state ?? {};
  armor.state.durability = newDur;

  const instRegionId = armor.regionId;
  const instId = armor.id;
  await redis.set(mobKey(instRegionId, instId), JSON.stringify(armor));
  await markDirty('instance', `${instRegionId ?? 'null'}:${instId}`);

  if (newDur <= 0) {
    await applyCondition('instance', `${instRegionId ?? 'null'}:${instId}`, 'armor_broken', null, currentTick);
  }
}

// ─── Wound helpers ────────────────────────────────────────────────────────────

async function applyWoundToAvatar(avatarId, currentTick, emit, sendOutput, actorSessionToken) {
  const raw = await redis.get(`avatar:${avatarId}`);
  if (!raw) return false;
  const avatar = JSON.parse(raw);
  avatar.wounds = (avatar.wounds ?? 0) + 1;
  await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', avatarId);

  emit('avatar', String(avatarId), 'on_wound', { actorAvatarId: avatarId });

  if (avatar.wounds >= (avatar.woundMax ?? 3)) {
    emit('avatar', String(avatarId), 'on_kill', { actorSessionToken });
    return true; // killed
  }
  return false;
}

async function applyWoundToMob(mob, tmpl, regionId, instanceId, currentTick, emit, sendOutput, actorSessionToken) {
  mob.state = mob.state ?? {};
  mob.state.wounds = (mob.state.wounds ?? 0) + 1;
  const woundMax = tmpl?.baseSchema?.woundMax ?? 3;
  await saveMob(regionId, instanceId, mob);

  emit('instance', `${regionId}:${instanceId}`, 'on_wound', { actorSessionToken });

  if (mob.state.wounds >= woundMax) {
    emit('instance', `${regionId}:${instanceId}`, 'on_kill', { actorSessionToken, regionId, instanceId });
    // Drop loot
    await _dropLoot(regionId, instanceId, tmpl, currentTick);
    return true; // killed
  }
  return false;
}

async function _dropLoot(regionId, locationId, tmpl, currentTick) {
  const lootTable = Array.isArray(tmpl?.lootTable) ? tmpl.lootTable : [];
  for (const entry of lootTable) {
    if (Math.random() * 100 < (entry.dropChance ?? 50)) {
      // Find next available instance id in this region
      const maxRow = await db.objectInstance.findFirst({
        where: { regionId },
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      const newId = (maxRow?.id ?? 0) + 1;
      await db.objectInstance.create({
        data: {
          id: newId,
          regionId,
          templateId: entry.templateId,
          ownerType: 'LOCATION',
          ownerId: String(locationId),
          state: {},
          isState: {},
          count: entry.quantity ?? 1,
        },
      });
    }
  }
}

// ─── Main combat handler (phase 3, category 'combat') ────────────────────────

export const combatHandler = {
  async roll(action) {
    const { actorAvatarId, skillId } = action.context;
    const avRaw = await redis.get(`avatar:${actorAvatarId}`);
    if (!avRaw) return resolve(action.sessionToken, null);
    const attacker = JSON.parse(avRaw);
    const target = await getRollTarget(attacker, 'phy_for', skillId ?? null);
    return resolve(action.sessionToken, target);
  },

  async apply(action, result, emit, tick, sendOutput) {
    const { context } = action;
    const {
      actorAvatarId, actorSessionToken, regionId, locationId,
      targetType, targetRegionId, targetInstanceId, targetAvatarId,
      skillId,
    } = context;

    // Load attacker
    const avRaw = await redis.get(`avatar:${actorAvatarId}`);
    if (!avRaw) return;
    const attacker = JSON.parse(avRaw);

    // Load defender
    let defenderName, defenderSessionToken = null;
    let mob = null, mobTmpl = null;

    if (targetType === 'mob') {
      mob = await loadMob(targetRegionId, targetInstanceId);
      if (!mob) {
        sendOutput([actorSessionToken], renderOutput('[color=red]Target is gone.[/]'));
        return;
      }
      mobTmpl = mob.template ?? await db.objectTemplate.findUnique({ where: { id: mob.templateId } });
      defenderName = mobTmpl?.name ?? 'mob';
    } else if (targetType === 'avatar') {
      const tRaw = await redis.get(`avatar:${targetAvatarId}`);
      if (!tRaw) {
        sendOutput([actorSessionToken], renderOutput('[color=red]Target is gone.[/]'));
        return;
      }
      const targetAv = JSON.parse(tRaw);
      defenderName = targetAv.name;
      const tUser = await db.user.findFirst({
        where: { avatars: { some: { id: targetAvatarId } } },
        select: { sessionToken: true },
      });
      defenderSessionToken = tUser?.sessionToken ?? null;
    }

    // First-contact in_combat
    if (!hasCondition(attacker, 'in_combat')) {
      await applyCondition('avatar', actorAvatarId, 'in_combat', null, tick);
      // Store combat target
      const av = JSON.parse(await redis.get(`avatar:${actorAvatarId}`) ?? 'null');
      if (av) {
        av.state = av.state ?? {};
        av.state.combatTarget = targetType === 'mob'
          ? { type: 'mob', regionId: targetRegionId, instanceId: targetInstanceId }
          : { type: 'avatar', avatarId: targetAvatarId };
        await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(av));
        await markDirty('avatar', actorAvatarId);
      }
      emit('avatar', String(actorAvatarId), 'on_combat_start', { actorAvatarId, actorSessionToken });
    }

    // Emit on_melee to Response (always)
    emit('location', `${regionId}:${locationId}`, 'on_melee', {
      regionId, locationId, actorAvatarId, actorSessionToken,
      targetType, targetRegionId, targetInstanceId, targetAvatarId,
    });

    // Resolve attack outcome
    if (result.outcome === 'fail') {
      sendOutput([actorSessionToken], renderOutput(`[dim]Your attack on [/][b]${esc(defenderName)}[/][dim] misses.[/]`));
      // Push stress increment for failed gated roll
      await redis.rPush('stress:pending', JSON.stringify({ avatarId: actorAvatarId, amount: 1 }));
      return;
    }

    let woundLands = false;

    if (result.outcome === 'strong') {
      woundLands = true;
    } else {
      // weak → opposed check vs defender resistance
      const defPhyFor = _getEntityStat(targetType === 'mob' ? mob : null, 'phy_for', targetType === 'mob' ? mobTmpl : null);
      let defPhyRes = _getEntityStat(targetType === 'mob' ? mob : null, 'phy_res', targetType === 'mob' ? mobTmpl : null);
      const attackerPhyFor = await getRollTarget(attacker, 'phy_for', skillId ?? null);

      // Armor mod
      let armorInst = null;
      if (targetType === 'avatar') {
        armorInst = await getEquippedArmor(targetAvatarId);
      } else if (mob && mob.isState?.equipped_armor) {
        // Mobs can have armor via isState — future extension
      }
      const armorMod = armorInst ? (armorInst.template?.baseSchema?.defenseMod ?? 5) : 0;

      const opposed = resolveOpposed(
        actorSessionToken,
        defenderSessionToken,
        attackerPhyFor,
        defPhyRes + armorMod,
      );
      woundLands = opposed.winner === 'attacker';
    }

    if (!woundLands) {
      sendOutput([actorSessionToken], renderOutput(`Your attack on [b]${esc(defenderName)}[/] is absorbed.`));
      return;
    }

    // Armor intercept
    let armorInst = null;
    if (targetType === 'avatar') {
      armorInst = await getEquippedArmor(targetAvatarId);
    }
    if (armorInst) {
      await decrementArmorDurability(armorInst, tick, sendOutput);
    }

    // Apply wound
    let killed = false;
    if (targetType === 'mob') {
      killed = await applyWoundToMob(mob, mobTmpl, targetRegionId, targetInstanceId, tick, emit, sendOutput, actorSessionToken);
    } else {
      killed = await applyWoundToAvatar(targetAvatarId, tick, emit, sendOutput, actorSessionToken);
    }

    sendOutput([actorSessionToken], renderOutput(
      killed
        ? `You [b]kill[/] [b]${esc(defenderName)}[/]!`
        : `You [color=red]wound[/] [b]${esc(defenderName)}[/].`
    ));

    logger.info('COMBAT', 'attack_resolved', {
      attackerAvatarId: actorAvatarId, defenderName, outcome: result.outcome, woundLands, killed,
    });
  },
};

// ─── Death handler (Response phase, event 'on_kill') ─────────────────────────

export const killHandler = {
  async apply(_action, _result, _emit, _tick, _sendOutput) {
    // Mob death: handled via loot drop in applyWoundToMob above.
    // Avatar death: survival tick applies dying condition; conditionExpireHandler respawns.
  },
};

// ─── Respawn handler (Response phase, event 'on_condition_expire' dying) ─────

export const conditionExpireHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    // action.context contains the emitEvent data: { conditionName, ... }
    const ctx = action.context ?? {};
    if (ctx.conditionName !== 'dying') return;

    const entityId = ctx.targetId ?? ctx.entityId;
    const entityType = ctx.targetType ?? ctx.entityType ?? 'avatar';
    if (entityType !== 'avatar') return;

    const avatarId = parseInt(String(entityId));
    await _respawnAvatar(avatarId, tick, emit, sendOutput);
  },
};

async function _respawnAvatar(avatarId, tick, emit, sendOutput) {
  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return;
  const avatar = JSON.parse(avRaw);

  // Only respawn if wounds still at max (not healed during dying window)
  if ((avatar.wounds ?? 0) < (avatar.woundMax ?? 3)) return;

  // Find entry location for this region
  const regionId = avatar.regionId;
  let entryLocationId = null;
  if (regionId != null) {
    const region = await db.region.findUnique({ where: { id: regionId }, select: { config: true } });
    entryLocationId = region?.config?.entryLocationId ?? null;
    if (entryLocationId == null) {
      // Fall back to first location in region
      const firstLoc = await db.location.findFirst({ where: { regionId }, orderBy: { id: 'asc' }, select: { id: true } });
      entryLocationId = firstLoc?.id ?? null;
    }
  }

  // Clear wounds and combat state
  avatar.wounds = 0;
  avatar.activeConditions = (avatar.activeConditions ?? []).filter(c =>
    !['wounded_1','wounded_2','wounded_3','dying','in_combat'].includes(c.name)
  );
  delete avatar.state?.combatTarget;

  // Move to entry location
  if (entryLocationId != null) {
    avatar.locationId = entryLocationId;
  }

  await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', avatarId);

  // Notify the avatar's session if findable
  const user = await db.user.findFirst({
    where: { avatars: { some: { id: avatarId } } },
    select: { sessionToken: true },
  });
  if (user?.sessionToken) {
    sendOutput([user.sessionToken], renderOutput('[color=yellow]You have died and been returned to safety.[/]'));
  }

  logger.info('COMBAT', 'avatar_respawned', { avatarId, entryLocationId });
}

// Helper: get an entity stat value (works for avatars and mobs)
function _getEntityStat(entity, statKey, tmpl) {
  if (!entity) return 20; // baseline
  // Avatar: entity.stats[statKey].value
  if (entity.stats?.[statKey]?.value != null) return Math.min(entity.stats[statKey].value, 40);
  // Mob: entity.state.stats or template.baseSchema.stats
  if (entity.state?.stats?.[statKey] != null) return Math.min(entity.state.stats[statKey], 40);
  const tmplStats = tmpl?.baseSchema?.stats ?? {};
  if (tmplStats[statKey] != null) return Math.min(tmplStats[statKey], 40);
  return 20;
}

// ─── Horror / Sanity handler (Response phase, events on_horror / on_dread / on_mindbend) ─

export const horrorHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    const targetAvatarId = ctx.targetAvatarId ?? parseInt(String(ctx.targetId));
    const { sourceSessionToken, sourceMenFor } = ctx;

    if (!targetAvatarId) return;

    const avRaw = await redis.get(`avatar:${targetAvatarId}`);
    if (!avRaw) return;
    const target = JSON.parse(avRaw);

    const targetMenRes = Math.min(target.stats?.men_res?.value ?? 20, 40);
    const srcMenFor    = Math.min(sourceMenFor ?? 20, 40);

    const tUser = await db.user.findFirst({
      where: { avatars: { some: { id: targetAvatarId } } },
      select: { sessionToken: true },
    });
    const targetToken = tUser?.sessionToken ?? null;

    const opposed = resolveOpposed(sourceSessionToken ?? null, targetToken, srcMenFor, targetMenRes);
    if (opposed.winner !== 'attacker') return; // horror resisted

    target.sanity = (target.sanity ?? 0) + 1;
    const sanityMax = target.sanityMax ?? 3;
    await redis.set(`avatar:${targetAvatarId}`, JSON.stringify(target));
    await markDirty('avatar', targetAvatarId);

    emit('avatar', String(targetAvatarId), 'on_sanity_damage', { targetAvatarId });

    if (targetToken) {
      sendOutput([targetToken], renderOutput('[color=magenta]Your mind reels from the horror![/]'));
    }

    if (target.sanity >= sanityMax) {
      const regionId = target.regionId;
      let breakBehavior = 'condition_only';
      let breakDuration = 10;
      if (regionId != null) {
        const region = await db.region.findUnique({ where: { id: regionId }, select: { config: true } });
        breakBehavior = region?.config?.sanityBreakBehavior ?? 'condition_only';
        breakDuration = region?.config?.sanityBreakDurationTicks ?? 10;
      }
      await _applySanityBreak(targetAvatarId, breakBehavior, breakDuration, tick, sendOutput, targetToken, emit);
    }

    logger.info('COMBAT', 'horror_applied', { targetAvatarId, sanity: target.sanity });
  },
};

async function _applySanityBreak(avatarId, behavior, durationTicks, tick, sendOutput, sessionToken, emit) {
  switch (behavior) {
    case 'confusion':
      await applyCondition('avatar', avatarId, 'confusion', durationTicks, tick);
      break;
    case 'flee':
      await applyCondition('avatar', avatarId, 'flee_state', durationTicks, tick);
      break;
    case 'panic':
      await applyCondition('avatar', avatarId, 'panic', durationTicks, tick);
      break;
    case 'comatose':
      await applyCondition('avatar', avatarId, 'comatose', null, tick);
      await _respawnAvatarSanity(avatarId, tick, sendOutput, sessionToken);
      return; // _respawnAvatarSanity sends its own message
    case 'mental_break':
      await applyCondition('avatar', avatarId, 'mental_break', null, tick);
      break;
    default: // 'condition_only' — survival chain applies broken via sanity track
      break;
  }

  if (sessionToken) {
    sendOutput([sessionToken], renderOutput('[color=magenta]Your mind breaks![/]'));
  }
}

async function _respawnAvatarSanity(avatarId, tick, sendOutput, sessionToken) {
  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return;
  const avatar = JSON.parse(avRaw);

  const regionId = avatar.regionId;
  let entryLocationId = null;
  if (regionId != null) {
    const region = await db.region.findUnique({ where: { id: regionId }, select: { config: true } });
    entryLocationId = region?.config?.entryLocationId ?? null;
    if (entryLocationId == null) {
      const firstLoc = await db.location.findFirst({ where: { regionId }, orderBy: { id: 'asc' }, select: { id: true } });
      entryLocationId = firstLoc?.id ?? null;
    }
  }

  avatar.sanity = 0;
  avatar.activeConditions = (avatar.activeConditions ?? []).filter(c =>
    !['shaken_1','shaken_2','shaken_3','broken','confusion','flee_state','comatose','in_combat'].includes(c.name)
  );
  delete avatar.state?.combatTarget;
  if (entryLocationId != null) avatar.locationId = entryLocationId;

  await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', avatarId);

  if (sessionToken) {
    sendOutput([sessionToken], renderOutput('[color=yellow]Your mind shatters. You are returned to safety.[/]'));
  }

  logger.info('COMBAT', 'avatar_sanity_respawn', { avatarId, entryLocationId });
}
