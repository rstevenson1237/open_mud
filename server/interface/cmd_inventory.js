// Inventory commands: get/take, drop, give, i/inventory, examine/x,
//   open/close, put/take-from, use, wear/equip/remove, trade stub
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { enqueueAction } from '../tick/queue.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { checkPermission } from '../engine/permissions.js';

export function register() {
  registerCommand('get',       handleGet,        { aliases: ['take'], minUserType: 'CHARACTER', group: 'inventory', description: 'Pick up an item' });
  registerCommand('drop',      handleDrop,       { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Drop an item' });
  registerCommand('give',      handleGive,       { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Give an item to someone' });
  registerCommand('inventory', handleInventory,  { aliases: ['i'],     minUserType: 'CHARACTER', group: 'inventory', description: 'List carried items' });
  registerCommand('examine',   handleExamine,    { aliases: ['x'],     minUserType: 'CHARACTER', group: 'inventory', description: 'Inspect an item' });
  registerCommand('open',      handleOpen,       { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Open a container or door' });
  registerCommand('close',     handleClose,      { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Close a container or door' });
  registerCommand('put',       handlePut,        { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Put an item in a container' });
  registerCommand('use',       handleUse,        { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Use an item' });
  registerCommand('wear',      handleWear,       { aliases: ['equip'], minUserType: 'CHARACTER', group: 'inventory', description: 'Equip an item' });
  registerCommand('remove',    handleRemove,     { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Unequip an item' });
  registerCommand('trade',     handleTrade,      { aliases: [],        minUserType: 'CHARACTER', group: 'inventory', description: 'Trade with another player' });
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

async function resolveAtLocation(name, regionId, locationId) {
  const instances = await db.objectInstance.findMany({
    where: { regionId, ownerType: 'LOCATION', ownerId: String(locationId) },
    include: { template: { select: { id: true, name: true, aliases: true, weight: true, type: true } } },
  });
  return _matchByName(instances, name);
}

async function resolveInInventory(name, avatarId) {
  const instances = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { id: true, name: true, aliases: true, weight: true, type: true } } },
  });
  return _matchByName(instances, name);
}

async function resolveReachable(name, regionId, locationId, avatarId) {
  const atLoc = await resolveAtLocation(name, regionId, locationId);
  if (atLoc) return atLoc;
  return resolveInInventory(name, avatarId);
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

function extractTarget(parts, skip = 1) {
  return parts.slice(skip).join(' ').trim();
}

function buildInstanceContext(inst, extra = {}) {
  return {
    instanceId: inst.id,
    instanceRegionId: inst.regionId,
    templateId: inst.templateId,
    weight: inst.template?.weight ?? 1,
    isCoin: inst.template?.type === 'COIN',
    coinCount: inst.count ?? 1,
    coinWeightDivisor: 100,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// get/take
// ---------------------------------------------------------------------------

async function handleGet(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);

  // 'take X from Y' → redirect to put/take-from pattern
  const fromIdx = parts.indexOf('from');
  if (fromIdx > 1) {
    return _handleTakeFrom(ctx, parts, fromIdx);
  }

  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] get {item}') };

  const inst = await resolveAtLocation(targetName, ctx.regionId, ctx.locationId);
  if (!inst) return { output: renderOutput(`[color=red]You don't see '${_esc(targetName)}' here.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'get',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      ...buildInstanceContext(inst),
    },
  });
  return { output: null };
}

async function _handleTakeFrom(ctx, parts, fromIdx) {
  const itemName = parts.slice(1, fromIdx).join(' ');
  const containerName = parts.slice(fromIdx + 1).join(' ');
  if (!itemName || !containerName) {
    return { output: renderOutput('[b]Usage:[/] take {item} from {container}') };
  }

  const container = await resolveReachable(containerName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!container) return { output: renderOutput(`[color=red]You don't see '${_esc(containerName)}' here.[/]`) };

  // Find item inside the container
  const containerOwnerId = `${container.regionId}:${container.id}`;
  const items = await db.objectInstance.findMany({
    where: { ownerType: 'CONTAINER', ownerId: containerOwnerId },
    include: { template: { select: { id: true, name: true, aliases: true, weight: true, type: true } } },
  });
  const inst = _matchByName(items, itemName);
  if (!inst) return { output: renderOutput(`[color=red]'${_esc(itemName)}' is not in that container.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'take_from',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      containerId: container.id,
      containerRegionId: container.regionId,
      ...buildInstanceContext(inst),
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

async function handleDrop(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] drop {item}') };

  const inst = await resolveInInventory(targetName, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't have '${_esc(targetName)}'.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'drop',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      ...buildInstanceContext(inst),
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// give
// ---------------------------------------------------------------------------

async function handleGive(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  // give {item} to @target  or  give @target {item}
  const parts = ctx.raw.trim().split(/\s+/);
  if (parts.length < 3) return { output: renderOutput('[b]Usage:[/] give {item} @target') };

  let itemName, targetArg;
  const toIdx = parts.indexOf('to');
  if (toIdx > 1) {
    itemName = parts.slice(1, toIdx).join(' ');
    targetArg = parts[toIdx + 1] ?? '';
  } else {
    itemName = parts.slice(2).join(' ');
    targetArg = parts[1];
  }

  const inst = await resolveInInventory(itemName, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't have '${_esc(itemName)}'.[/]`) };

  // Resolve target avatar in same location
  const tName = targetArg.replace(/^@/, '');
  const targetAv = await db.avatar.findFirst({
    where: { name: { equals: tName, mode: 'insensitive' }, isActive: true },
    select: { id: true, name: true, userId: true },
  });
  if (!targetAv) return { output: renderOutput(`[color=red]'${_esc(tName)}' is not here.[/]`) };

  // Find target session token
  const targetUser = await db.user.findUnique({ where: { id: targetAv.userId }, select: { sessionToken: true } });
  const targetSessionToken = targetUser?.sessionToken ?? null;

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'give',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      targetAvatarId: targetAv.id,
      targetSessionToken,
      ...buildInstanceContext(inst),
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// inventory (inline)
// ---------------------------------------------------------------------------

async function handleInventory(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };

  const items = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(ctx.avatarId) },
    include: { template: { select: { name: true, weight: true, type: true } } },
  });

  // Load avatar for carry cap and encumbered
  const avRaw = await redis.get(`avatar:${ctx.avatarId}`);
  const avatar = avRaw ? JSON.parse(avRaw) : null;
  const carryWeight = avatar?.state?.carryWeight ?? 0;
  const cap = avatar?.carryCapacity ?? 100;
  const threshold = avatar?.encumberedThreshold ?? 80;

  if (items.length === 0) {
    return { output: renderOutput(`[b]Inventory:[/] empty (${carryWeight}/${cap}wt)`) };
  }

  let out = `[b]Inventory[/] (${carryWeight}/${cap}wt${carryWeight > threshold ? ' [color=yellow]encumbered[/]' : ''}):\n`;
  out += items.map(i => {
    const w = i.template.type === 'COIN' ? Math.ceil((i.count ?? 1) / 100) : (i.template.weight ?? 1);
    const extra = i.template.type === 'COIN' ? ` (${i.count ?? 1} coins)` : '';
    return `  [b]${i.template.name}[/]${extra} [dim](${w}wt)[/]`;
  }).join('\n');

  return { output: renderOutput(out) };
}

// ---------------------------------------------------------------------------
// examine (inline)
// ---------------------------------------------------------------------------

async function handleExamine(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] examine {item}') };

  const inst = await resolveReachable(targetName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't see '${_esc(targetName)}' here.[/]`) };

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId } });
  const desc = tmpl?.baseSchema?.description ?? tmpl?.name ?? 'An ordinary item.';

  let out = `[b]${_esc(tmpl?.name ?? 'item')}[/]\n${_esc(desc)}`;

  // Show visible state flags
  const is = inst.isState ?? {};
  const flags = Object.entries(is).filter(([k, v]) => v === true).map(([k]) => k);
  if (flags.length > 0) out += `\n[dim]${flags.join(', ')}[/]`;

  // Show game-type conditions (not mechanical)
  const gameConds = (inst.activeConditions ?? [])
    .filter(c => c.visibilityEffect && c.visibilityEffect !== 'none');
  if (gameConds.length > 0) out += '\n[dim]' + gameConds.map(c => c.name).join(', ') + '[/]';

  return { output: renderOutput(out) };
}

// ---------------------------------------------------------------------------
// open / close
// ---------------------------------------------------------------------------

async function handleOpen(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] open {item}') };

  const inst = await resolveReachable(targetName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't see '${_esc(targetName)}' here.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'open',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      instanceId: inst.id,
      instanceRegionId: inst.regionId,
    },
  });
  return { output: null };
}

async function handleClose(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] close {item}') };

  const inst = await resolveReachable(targetName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't see '${_esc(targetName)}' here.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'close',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      instanceId: inst.id,
      instanceRegionId: inst.regionId,
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// put {item} in {container}
// ---------------------------------------------------------------------------

async function handlePut(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const inIdx = parts.indexOf('in');
  if (inIdx < 2) return { output: renderOutput('[b]Usage:[/] put {item} in {container}') };

  const itemName = parts.slice(1, inIdx).join(' ');
  const containerName = parts.slice(inIdx + 1).join(' ');

  const inst = await resolveInInventory(itemName, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't have '${_esc(itemName)}'.[/]`) };

  const container = await resolveReachable(containerName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!container) return { output: renderOutput(`[color=red]You don't see '${_esc(containerName)}' here.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'put',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      ...buildInstanceContext(inst),
      containerId: container.id,
      containerRegionId: container.regionId,
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------

async function handleUse(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] use {item}') };

  const inst = await resolveReachable(targetName, ctx.regionId, ctx.locationId, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't see '${_esc(targetName)}' here.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'use',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      instanceId: inst.id,
      instanceRegionId: inst.regionId,
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// wear/equip
// ---------------------------------------------------------------------------

async function handleWear(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] wear {item}') };

  const inst = await resolveInInventory(targetName, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't have '${_esc(targetName)}'.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'wear',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      instanceId: inst.id,
      instanceRegionId: inst.regionId,
    },
  });
  return { output: null };
}

async function handleRemove(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = extractTarget(parts);
  if (!targetName) return { output: renderOutput('[b]Usage:[/] remove {item}') };

  const inst = await resolveInInventory(targetName, ctx.avatarId);
  if (!inst) return { output: renderOutput(`[color=red]You don't have '${_esc(targetName)}'.[/]`) };

  await enqueueAction({
    phase: 3, category: 'inventory',
    resourceKey: `instance:${inst.regionId}:${inst.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      actionType: 'remove',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      instanceId: inst.id,
      instanceRegionId: inst.regionId,
    },
  });
  return { output: null };
}

// ---------------------------------------------------------------------------
// trade stub
// ---------------------------------------------------------------------------

async function handleTrade(ctx) {
  return { output: renderOutput('[color=yellow]Trade (escrow) not yet implemented (TASK 15).[/]') };
}

function _esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
