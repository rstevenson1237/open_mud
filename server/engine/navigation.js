// Navigation system handler (worker-thread) + shared renderLook (usable from main thread too).
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { applyCondition, removeCondition, hasCondition } from './conditions.js';
import { resolve, resolveOpposed } from './resolver.js';
import { getRollTarget } from './stats.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

/**
 * Render the full look description for a location.
 * Pure async function — safe to call from both main and worker threads.
 */
export async function renderLook(regionId, locationId, viewerAvatarId) {
  const rId = parseInt(regionId);
  const lId = parseInt(locationId);

  const loc = await db.location.findUnique({
    where: { regionId_id: { regionId: rId, id: lId } },
  });
  if (!loc) return renderOutput('[color=red]Location not found.[/]');

  let out = `[b]${loc.name}[/]\n${loc.description || ''}`;

  // Exits (hide ones with isState.hidden)
  const exits = await db.exit.findMany({
    where: { regionId: rId, fromLocationId: lId },
  });
  const visibleExits = exits.filter(e => {
    const is = (e.isState && typeof e.isState === 'object') ? e.isState : {};
    return !is.hidden;
  });
  out += visibleExits.length > 0
    ? `\n[dim]Exits: ${visibleExits.map(e => e.direction).join(', ')}[/]`
    : '\n[dim]No visible exits.[/]';

  // Objects at this location (hide hidden ones)
  const instances = await db.objectInstance.findMany({
    where: { regionId: rId, ownerType: 'LOCATION', ownerId: String(lId) },
    include: { template: { select: { name: true } } },
  });
  const visibleItems = instances.filter(o => {
    const is = (o.isState && typeof o.isState === 'object') ? o.isState : {};
    return !is.hidden;
  });
  if (visibleItems.length > 0) {
    out += '\n' + visibleItems.map(o => `  ${o.template.name}`).join('\n');
  }

  // Other active avatars at this location (DB read; accurate after flush)
  const others = await db.avatar.findMany({
    where: { regionId: rId, locationId: lId, isActive: true },
    select: { id: true, name: true },
  });
  const colocated = others.filter(a => a.id !== viewerAvatarId);
  if (colocated.length > 0) {
    out += '\n' + colocated.map(a => `  [b]${a.name}[/] is here.`).join('\n');
  }

  return renderOutput(out);
}

/**
 * SYSTEM_HANDLERS entry for category 'movement'.
 * Registered in engine.js via registerSystemHandler('movement', navigationHandler).
 * Extended by TASK 10 (flee/run) via context.moveType.
 */
export const navigationHandler = {
  roll(action) {
    // Movement is ungated: roll for ordering only, no target number.
    return resolve(action.sessionToken, null);
  },

  async apply(action, result, emit, tick, sendOutput) {
    const { context } = action;
    const moveType = context.moveType ?? 'go';

    if (moveType === 'go') {
      await _applyGo(context, emit, sendOutput);
    } else if (moveType === 'flee') {
      await _applyFlee(context, emit, tick, sendOutput);
    }
  },
};

async function _applyGo(context, emit, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId, direction } = context;
  const rId = parseInt(regionId);
  const lId = parseInt(locationId);

  const raw = await redis.get(`avatar:${actorAvatarId}`);
  if (!raw) return;
  const avatar = JSON.parse(raw);

  // Block movement if in_combat
  if (hasCondition(avatar, 'in_combat')) {
    sendOutput(
      [actorSessionToken],
      renderOutput("[color=yellow]You cannot move while in combat. Use 'run' to attempt to flee.[/]"),
    );
    return;
  }

  // Find exit in requested direction
  const exit = await db.exit.findFirst({
    where: { regionId: rId, fromLocationId: lId, direction },
  });
  if (!exit) {
    sendOutput([actorSessionToken], renderOutput(`[color=red]There is no exit to the ${direction}.[/]`));
    return;
  }

  // Check locked
  const exitIs = (exit.isState && typeof exit.isState === 'object') ? exit.isState : {};
  if (exitIs.locked) {
    sendOutput([actorSessionToken], renderOutput(`[color=red]The way ${direction} is locked.[/]`));
    return;
  }

  const destRegionId = exit.toRegionId ?? rId;
  const destLocationId = exit.toLocationId;
  const oldRegionId = avatar.regionId ?? rId;
  const oldLocationId = avatar.locationId ?? lId;

  // First-visit tracking
  let visitedRegions = Array.isArray(avatar.visitedRegions) ? [...avatar.visitedRegions] : [];
  const isFirstVisit = !visitedRegions.includes(destRegionId);
  if (isFirstVisit) visitedRegions.push(destRegionId);

  avatar.regionId = destRegionId;
  avatar.locationId = destLocationId;
  avatar.visitedRegions = visitedRegions;

  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', actorAvatarId);

  // Keep session in sync
  const sessionRaw = await redis.get(`session:${actorSessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.regionId = destRegionId;
    session.locationId = destLocationId;
    await redis.set(`session:${actorSessionToken}`, JSON.stringify(session));
  }

  // Queue Response-phase triggers
  emit('location', `${oldRegionId}:${oldLocationId}`, 'on_exit', {
    regionId: oldRegionId, locationId: oldLocationId,
    actorAvatarId, actorSessionToken,
    locationSessionTokens: [],
  });
  emit('location', `${destRegionId}:${destLocationId}`, 'on_enter', {
    regionId: destRegionId, locationId: destLocationId,
    actorAvatarId, actorSessionToken, isFirstVisit,
    locationSessionTokens: [],
  });

  // Render new location to the mover
  const lookHtml = await renderLook(destRegionId, destLocationId, actorAvatarId);
  sendOutput([actorSessionToken], lookHtml);

  logger.info('NAVIGATION', 'avatar_moved', {
    avatarId: actorAvatarId,
    from: `${oldRegionId}:${oldLocationId}`,
    to: `${destRegionId}:${destLocationId}`,
    direction,
  });
}

// ─── Flee (phase 1 movement) ──────────────────────────────────────────────────

async function _applyFlee(context, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId, combatTarget } = context;
  const rId = parseInt(regionId);
  const lId = parseInt(locationId);

  const raw = await redis.get(`avatar:${actorAvatarId}`);
  if (!raw) return;
  const fleer = JSON.parse(raw);

  if (!hasCondition(fleer, 'in_combat')) {
    sendOutput([actorSessionToken], renderOutput('[color=yellow]You are not in combat.[/]'));
    return;
  }

  // Determine chaser token and stats for opposed roll
  let chaserToken = null, chaserPhyPre = 20;
  if (combatTarget?.type === 'avatar') {
    const tUser = await db.user.findFirst({
      where: { avatars: { some: { id: combatTarget.avatarId } } },
      select: { sessionToken: true },
    });
    chaserToken = tUser?.sessionToken ?? null;
    const tRaw = chaserToken ? await redis.get(`avatar:${combatTarget.avatarId}`) : null;
    if (tRaw) {
      const chaser = JSON.parse(tRaw);
      chaserPhyPre = Math.min(chaser.stats?.phy_pre?.value ?? 20, 40);
    }
  }
  // For mob chasers, chaserToken = null → Math.random() in resolveOpposed

  const fleerPhyPre = Math.min(fleer.stats?.phy_pre?.value ?? 20, 40);

  // Flee: fleer wins ties — pass roles as (chaser, fleer) so tie → defender (fleer) wins
  const opposed = resolveOpposed(chaserToken, actorSessionToken, chaserPhyPre, fleerPhyPre);
  const fleerWins = opposed.winner === 'defender';

  if (!fleerWins) {
    sendOutput([actorSessionToken], renderOutput('[color=red]You fail to escape![/]'));
    emit('avatar', String(actorAvatarId), 'on_flee', { actorAvatarId, actorSessionToken, success: false });
    return;
  }

  // Clear in_combat
  await removeCondition('avatar', actorAvatarId, 'in_combat');
  // Clear state.combatTarget
  const avReloaded = JSON.parse(await redis.get(`avatar:${actorAvatarId}`) ?? '{}');
  if (avReloaded.state) delete avReloaded.state.combatTarget;
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avReloaded));
  await markDirty('avatar', actorAvatarId);

  // Move to a random unlocked exit
  const exits = await db.exit.findMany({ where: { regionId: rId, fromLocationId: lId } });
  const unlocked = exits.filter(e => !(e.isState?.locked));
  if (unlocked.length === 0) {
    sendOutput([actorSessionToken], renderOutput('[color=yellow]You escape but find no way out![/]'));
    emit('avatar', String(actorAvatarId), 'on_flee', { actorAvatarId, actorSessionToken, success: true });
    return;
  }

  const exit = unlocked[Math.floor(Math.random() * unlocked.length)];
  const destRegionId = exit.toRegionId ?? rId;
  const destLocationId = exit.toLocationId;

  const avFinal = JSON.parse(await redis.get(`avatar:${actorAvatarId}`) ?? '{}');
  let visitedRegions = Array.isArray(avFinal.visitedRegions) ? [...avFinal.visitedRegions] : [];
  if (!visitedRegions.includes(destRegionId)) visitedRegions.push(destRegionId);
  avFinal.regionId = destRegionId;
  avFinal.locationId = destLocationId;
  avFinal.visitedRegions = visitedRegions;
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avFinal));
  await markDirty('avatar', actorAvatarId);

  const sessionRaw = await redis.get(`session:${actorSessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.regionId = destRegionId;
    session.locationId = destLocationId;
    await redis.set(`session:${actorSessionToken}`, JSON.stringify(session));
  }

  const lookHtml = await renderLook(destRegionId, destLocationId, actorAvatarId);
  sendOutput([actorSessionToken], renderOutput(`[color=green]You escape![/]\n`) + lookHtml);

  emit('avatar', String(actorAvatarId), 'on_flee', { actorAvatarId, actorSessionToken, success: true, destRegionId, destLocationId });
  logger.info('NAVIGATION', 'avatar_fled', { avatarId: actorAvatarId, to: `${destRegionId}:${destLocationId}` });
}
