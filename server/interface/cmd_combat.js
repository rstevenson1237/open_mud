// Combat commands: attack, run/flee
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { enqueueAction } from '../tick/queue.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';

export function register() {
  registerCommand('attack', handleAttack, { aliases: ['kill', 'hit'], minUserType: 'CHARACTER' });
  registerCommand('run',    handleFlee,   { aliases: ['flee'],         minUserType: 'CHARACTER' });
}

// ---------------------------------------------------------------------------

async function handleAttack(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  if (ctx.regionId == null || ctx.locationId == null) {
    return { output: renderOutput('[color=yellow]You cannot fight here.[/]') };
  }

  // Check zone (must not be SAFE)
  const loc = await db.location.findUnique({
    where: { regionId_id: { regionId: ctx.regionId, id: ctx.locationId } },
    select: { zoneType: true },
  });
  if (!loc || loc.zoneType === 'SAFE') {
    return { output: renderOutput('[color=yellow]You cannot attack in a safe zone.[/]') };
  }

  const parts = ctx.raw.trim().split(/\s+/);
  // attack {target} [with {weapon}]
  const withIdx = parts.indexOf('with');
  const targetName = withIdx > 1
    ? parts.slice(1, withIdx).join(' ')
    : parts.slice(1).join(' ');
  const weaponName = withIdx > 1 ? parts.slice(withIdx + 1).join(' ') : null;

  if (!targetName) return { output: renderOutput('[b]Usage:[/] attack {target}') };

  // Try to find a MOB instance at current location
  const mobs = await db.objectInstance.findMany({
    where: { regionId: ctx.regionId, ownerType: 'LOCATION', ownerId: String(ctx.locationId) },
    include: { template: { select: { id: true, name: true, type: true, aliases: true } } },
  });
  const mobInst = _matchByName(mobs.filter(i => i.template.type === 'MOB'), targetName);

  if (mobInst) {
    // Determine skill from weapon if specified
    let skillId = null;
    if (weaponName) {
      const weapon = await db.objectInstance.findFirst({
        where: { ownerType: 'AVATAR', ownerId: String(ctx.avatarId) },
        include: { template: { select: { name: true, baseSchema: true } } },
      });
      if (weapon) skillId = weapon.template?.baseSchema?.weaponSkillId ?? null;
    }

    await enqueueAction({
      phase: 3, category: 'combat',
      resourceKey: `instance:${mobInst.regionId}:${mobInst.id}`,
      sessionToken: ctx.sessionToken,
      context: {
        actionType: 'attack',
        actorAvatarId: ctx.avatarId,
        actorSessionToken: ctx.sessionToken,
        regionId: ctx.regionId,
        locationId: ctx.locationId,
        targetType: 'mob',
        targetRegionId: mobInst.regionId,
        targetInstanceId: mobInst.id,
        skillId,
      },
    });
    return { output: renderOutput(`[dim]You ready your attack on [/][b]${_esc(mobInst.template.name)}[/][dim]...[/]`) };
  }

  // Try avatar target (@name)
  const tName = targetName.replace(/^@/, '');
  const targetAv = await db.avatar.findFirst({
    where: { name: { equals: tName, mode: 'insensitive' }, isActive: true, regionId: ctx.regionId, locationId: ctx.locationId },
    select: { id: true, name: true },
  });
  if (targetAv) {
    await enqueueAction({
      phase: 3, category: 'combat',
      resourceKey: `avatar:${targetAv.id}`,
      sessionToken: ctx.sessionToken,
      context: {
        actionType: 'attack',
        actorAvatarId: ctx.avatarId,
        actorSessionToken: ctx.sessionToken,
        regionId: ctx.regionId,
        locationId: ctx.locationId,
        targetType: 'avatar',
        targetAvatarId: targetAv.id,
        skillId: null,
      },
    });
    return { output: renderOutput(`[dim]You ready your attack on [/][b]${_esc(targetAv.name)}[/][dim]...[/]`) };
  }

  return { output: renderOutput(`[color=red]'${_esc(targetName)}' is not here.[/]`) };
}

async function handleFlee(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  if (ctx.regionId == null || ctx.locationId == null) {
    return { output: renderOutput('[color=yellow]Nowhere to flee to.[/]') };
  }

  // Load avatar to check in_combat
  const avRaw = await redis.get(`avatar:${ctx.avatarId}`);
  const avatar = avRaw ? JSON.parse(avRaw) : null;
  const inCombat = avatar?.activeConditions?.some(c => c.name === 'in_combat');
  if (!inCombat) {
    return { output: renderOutput('[color=yellow]You are not in combat.[/]') };
  }

  const combatTarget = avatar?.state?.combatTarget;

  await enqueueAction({
    phase: 1, category: 'movement',
    resourceKey: `avatar:${ctx.avatarId}`,
    sessionToken: ctx.sessionToken,
    context: {
      moveType: 'flee',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      combatTarget,
    },
  });
  return { output: renderOutput('[dim]You attempt to flee...[/]') };
}

function _matchByName(instances, name) {
  const lc = name.toLowerCase();
  return instances.find(i => {
    if (i.template.name.toLowerCase() === lc) return true;
    const al = i.template.aliases;
    if (Array.isArray(al)) return al.some(a => a.toLowerCase() === lc);
    if (al && typeof al === 'object') return Object.keys(al).some(a => a.toLowerCase() === lc);
    return false;
  }) ?? null;
}

function _esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
