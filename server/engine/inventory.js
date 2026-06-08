// Inventory system handler (worker-thread phase 3).
// Registered in engine.js via registerSystemHandler('inventory', inventoryHandler).
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { applyCondition, removeCondition, hasCondition } from './conditions.js';
import { resolve } from './resolver.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

// Instance Redis key: instance:{regionId}:{id}  (regionId may be 'null')
function instanceKey(regionId, id) {
  return `instance:${regionId ?? 'null'}:${id}`;
}

// Load instance from Redis hot-state, falling back to DB.
async function loadInstance(regionId, id) {
  const raw = await redis.get(instanceKey(regionId, id));
  if (raw) return JSON.parse(raw);
  // Fall back to DB
  const inst = regionId == null
    ? await db.objectInstance.findFirst({ where: { regionId: null, id } })
    : await db.objectInstance.findUnique({ where: { regionId_id: { regionId, id } } });
  return inst ?? null;
}

async function saveInstance(regionId, id, instance) {
  await redis.set(instanceKey(regionId, id), JSON.stringify(instance));
  await markDirty('instance', `${regionId ?? 'null'}:${id}`);
}

// Compute current carry weight for an avatar from DB inventory.
// Within-tick accuracy note: items picked up this tick are in Redis but not yet in DB.
// We use avatar.state.carryWeight as a running cache updated per action.
function currentCarryWeight(avatar) {
  return avatar.state?.carryWeight ?? 0;
}

export const inventoryHandler = {
  roll(action) {
    return resolve(action.sessionToken, null); // ungated, roll for ordering
  },

  async apply(action, result, emit, tick, sendOutput) {
    const { actionType } = action.context;
    switch (actionType) {
      case 'get':       return _applyGet(action, emit, tick, sendOutput);
      case 'drop':      return _applyDrop(action, emit, tick, sendOutput);
      case 'give':      return _applyGive(action, emit, tick, sendOutput);
      case 'open':      return _applyOpenClose(action, true, emit, tick, sendOutput);
      case 'close':     return _applyOpenClose(action, false, emit, tick, sendOutput);
      case 'put':       return _applyPut(action, emit, tick, sendOutput);
      case 'take_from': return _applyTakeFrom(action, emit, tick, sendOutput);
      case 'use':       return _applyUse(action, emit, tick, sendOutput);
      case 'wear':      return _applyWearRemove(action, true, emit, tick, sendOutput);
      case 'remove':    return _applyWearRemove(action, false, emit, tick, sendOutput);
      default:
        logger.warn('INVENTORY', 'Unknown actionType', { actionType });
    }
  },
};

async function _applyGet(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId,
          instanceId, instanceRegionId, weight, isCoin, coinCount,
          coinWeightDivisor } = action.context;

  const avatarRaw = await redis.get(`avatar:${actorAvatarId}`);
  if (!avatarRaw) return;
  const avatar = JSON.parse(avatarRaw);

  // Load instance and verify it's still at the expected location
  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst) {
    sendOutput([actorSessionToken], renderOutput('[color=red]The item is gone.[/]'));
    return;
  }
  if (inst.ownerType !== 'LOCATION' || inst.ownerId !== String(locationId)) {
    sendOutput([actorSessionToken], renderOutput('[color=red]It has already been taken.[/]'));
    return;
  }

  // Compute item weight
  const itemWeight = isCoin
    ? Math.ceil((coinCount ?? 1) / (coinWeightDivisor ?? 100))
    : (weight ?? 1);

  const curWeight = currentCarryWeight(avatar);
  const newWeight = curWeight + itemWeight;

  if (newWeight > avatar.carryCapacity) {
    sendOutput([actorSessionToken], renderOutput('[color=red]You cannot carry that — too heavy.[/]'));
    return;
  }

  // Transfer ownership
  inst.ownerType = 'AVATAR';
  inst.ownerId = String(actorAvatarId);
  await saveInstance(instanceRegionId, instanceId, inst);

  // Update avatar carry weight cache
  avatar.state = avatar.state ?? {};
  avatar.state.carryWeight = newWeight;
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', actorAvatarId);

  // Apply/remove encumbered
  if (newWeight > avatar.encumberedThreshold && !hasCondition(avatar, 'encumbered')) {
    await applyCondition('avatar', actorAvatarId, 'encumbered', null, tick);
    sendOutput([actorSessionToken], renderOutput('[color=yellow]You are encumbered.[/]'));
  }

  // Load template name for output
  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const name = tmpl?.name ?? 'item';
  sendOutput([actorSessionToken], renderOutput(`You pick up the [b]${_esc(name)}[/].`));

  emit('instance', `${instanceRegionId}:${instanceId}`, 'on_take', {
    regionId, locationId, actorAvatarId, actorSessionToken,
  });
}

async function _applyDrop(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId,
          instanceId, instanceRegionId, weight, isCoin, coinCount, coinWeightDivisor } = action.context;

  const avatarRaw = await redis.get(`avatar:${actorAvatarId}`);
  if (!avatarRaw) return;
  const avatar = JSON.parse(avatarRaw);

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst || inst.ownerType !== 'AVATAR' || inst.ownerId !== String(actorAvatarId)) {
    sendOutput([actorSessionToken], renderOutput("[color=red]You don't have that.[/]"));
    return;
  }

  inst.ownerType = 'LOCATION';
  inst.ownerId = String(locationId);
  await saveInstance(instanceRegionId, instanceId, inst);

  const itemWeight = isCoin
    ? Math.ceil((coinCount ?? 1) / (coinWeightDivisor ?? 100))
    : (weight ?? 1);
  avatar.state = avatar.state ?? {};
  avatar.state.carryWeight = Math.max(0, (avatar.state.carryWeight ?? 0) - itemWeight);
  // Remove encumbered if below threshold
  if ((avatar.state.carryWeight ?? 0) <= avatar.encumberedThreshold && hasCondition(avatar, 'encumbered')) {
    await removeCondition('avatar', actorAvatarId, 'encumbered');
  }
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', actorAvatarId);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const name = tmpl?.name ?? 'item';
  sendOutput([actorSessionToken], renderOutput(`You drop the [b]${_esc(name)}[/].`));

  emit('instance', `${instanceRegionId}:${instanceId}`, 'on_take', {
    regionId, locationId, actorAvatarId, actorSessionToken,
  });
}

async function _applyGive(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId,
          instanceId, instanceRegionId, targetAvatarId, targetSessionToken,
          weight, isCoin, coinCount, coinWeightDivisor } = action.context;

  const avatarRaw = await redis.get(`avatar:${actorAvatarId}`);
  if (!avatarRaw) return;
  const avatar = JSON.parse(avatarRaw);

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst || inst.ownerType !== 'AVATAR' || inst.ownerId !== String(actorAvatarId)) {
    sendOutput([actorSessionToken], renderOutput("[color=red]You don't have that.[/]"));
    return;
  }

  // Verify target still in same location
  const targetRaw = await redis.get(`avatar:${targetAvatarId}`);
  const target = targetRaw ? JSON.parse(targetRaw) : null;
  if (!target || target.locationId !== locationId || target.regionId !== regionId) {
    sendOutput([actorSessionToken], renderOutput('[color=red]They are no longer here.[/]'));
    return;
  }

  // Weight check for target
  const itemWeight = isCoin
    ? Math.ceil((coinCount ?? 1) / (coinWeightDivisor ?? 100))
    : (weight ?? 1);
  const targetWeight = currentCarryWeight(target) + itemWeight;
  if (targetWeight > target.carryCapacity) {
    sendOutput([actorSessionToken], renderOutput('[color=red]They cannot carry that — too heavy.[/]'));
    return;
  }

  inst.ownerType = 'AVATAR';
  inst.ownerId = String(targetAvatarId);
  await saveInstance(instanceRegionId, instanceId, inst);

  // Update carry weights
  avatar.state = avatar.state ?? {};
  avatar.state.carryWeight = Math.max(0, (avatar.state.carryWeight ?? 0) - itemWeight);
  if ((avatar.state.carryWeight ?? 0) <= avatar.encumberedThreshold && hasCondition(avatar, 'encumbered')) {
    await removeCondition('avatar', actorAvatarId, 'encumbered');
  }
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', actorAvatarId);

  target.state = target.state ?? {};
  target.state.carryWeight = targetWeight;
  if (targetWeight > target.encumberedThreshold && !hasCondition(target, 'encumbered')) {
    await applyCondition('avatar', targetAvatarId, 'encumbered', null, tick);
    if (targetSessionToken) sendOutput([targetSessionToken], renderOutput('[color=yellow]You are encumbered.[/]'));
  }
  await redis.set(`avatar:${targetAvatarId}`, JSON.stringify(target));
  await markDirty('avatar', targetAvatarId);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const name = tmpl?.name ?? 'item';
  sendOutput([actorSessionToken], renderOutput(`You give the [b]${_esc(name)}[/] to [b]${_esc(target.name)}[/].`));
  if (targetSessionToken) {
    sendOutput([targetSessionToken], renderOutput(`[b]${_esc(avatar.name)}[/] gives you the [b]${_esc(name)}[/].`));
  }

  emit('instance', `${instanceRegionId}:${instanceId}`, 'on_give', {
    regionId, locationId, actorAvatarId, actorSessionToken, targetAvatarId,
  });
}

async function _applyOpenClose(action, opening, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, instanceId, instanceRegionId } = action.context;

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst) {
    sendOutput([actorSessionToken], renderOutput('[color=red]That is not here.[/]'));
    return;
  }

  const is = inst.isState ?? {};
  if (is.locked) {
    sendOutput([actorSessionToken], renderOutput('[color=red]It is locked.[/]'));
    return;
  }

  is.open = opening;
  inst.isState = is;
  await saveInstance(instanceRegionId, instanceId, inst);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const name = tmpl?.name ?? 'container';
  sendOutput([actorSessionToken], renderOutput(
    opening ? `You open the [b]${_esc(name)}[/].` : `You close the [b]${_esc(name)}[/].`
  ));

  emit('instance', `${instanceRegionId}:${instanceId}`, 'on_use', {
    actorAvatarId, actorSessionToken,
  });
}

async function _applyPut(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, instanceId, instanceRegionId,
          containerId, containerRegionId } = action.context;

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst || inst.ownerType !== 'AVATAR' || inst.ownerId !== String(actorAvatarId)) {
    sendOutput([actorSessionToken], renderOutput("[color=red]You don't have that.[/]"));
    return;
  }
  const container = await loadInstance(containerRegionId, containerId);
  if (!container) {
    sendOutput([actorSessionToken], renderOutput('[color=red]Container not found.[/]'));
    return;
  }
  if (!container.isState?.open) {
    sendOutput([actorSessionToken], renderOutput('[color=red]It is closed.[/]'));
    return;
  }

  inst.ownerType = 'CONTAINER';
  inst.ownerId = `${containerRegionId}:${containerId}`;
  await saveInstance(instanceRegionId, instanceId, inst);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const cTmpl = await db.objectTemplate.findUnique({ where: { id: container.templateId }, select: { name: true } });
  sendOutput([actorSessionToken], renderOutput(
    `You put the [b]${_esc(tmpl?.name ?? 'item')}[/] in the [b]${_esc(cTmpl?.name ?? 'container')}[/].`
  ));
}

async function _applyTakeFrom(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, regionId, locationId,
          instanceId, instanceRegionId, containerId, containerRegionId,
          weight, isCoin, coinCount, coinWeightDivisor } = action.context;

  const avatarRaw = await redis.get(`avatar:${actorAvatarId}`);
  if (!avatarRaw) return;
  const avatar = JSON.parse(avatarRaw);

  const container = await loadInstance(containerRegionId, containerId);
  if (!container?.isState?.open) {
    sendOutput([actorSessionToken], renderOutput('[color=red]The container is not open.[/]'));
    return;
  }

  const inst = await loadInstance(instanceRegionId, instanceId);
  const expectedOwnerId = `${containerRegionId}:${containerId}`;
  if (!inst || inst.ownerType !== 'CONTAINER' || inst.ownerId !== expectedOwnerId) {
    sendOutput([actorSessionToken], renderOutput('[color=red]That item is not in the container.[/]'));
    return;
  }

  const itemWeight = isCoin
    ? Math.ceil((coinCount ?? 1) / (coinWeightDivisor ?? 100))
    : (weight ?? 1);
  const newWeight = currentCarryWeight(avatar) + itemWeight;
  if (newWeight > avatar.carryCapacity) {
    sendOutput([actorSessionToken], renderOutput('[color=red]You cannot carry that — too heavy.[/]'));
    return;
  }

  inst.ownerType = 'AVATAR';
  inst.ownerId = String(actorAvatarId);
  await saveInstance(instanceRegionId, instanceId, inst);

  avatar.state = avatar.state ?? {};
  avatar.state.carryWeight = newWeight;
  if (newWeight > avatar.encumberedThreshold && !hasCondition(avatar, 'encumbered')) {
    await applyCondition('avatar', actorAvatarId, 'encumbered', null, tick);
    sendOutput([actorSessionToken], renderOutput('[color=yellow]You are encumbered.[/]'));
  }
  await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', actorAvatarId);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const cTmpl = await db.objectTemplate.findUnique({ where: { id: container.templateId }, select: { name: true } });
  sendOutput([actorSessionToken], renderOutput(
    `You take the [b]${_esc(tmpl?.name ?? 'item')}[/] from the [b]${_esc(cTmpl?.name ?? 'container')}[/].`
  ));
}

async function _applyUse(action, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, instanceId, instanceRegionId } = action.context;

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst) {
    sendOutput([actorSessionToken], renderOutput('[color=red]That is not here.[/]'));
    return;
  }

  emit('instance', `${instanceRegionId}:${instanceId}`, 'on_use', {
    actorAvatarId, actorSessionToken,
  });
  sendOutput([actorSessionToken], renderOutput('You use it.'));
}

async function _applyWearRemove(action, wearing, emit, tick, sendOutput) {
  const { actorAvatarId, actorSessionToken, instanceId, instanceRegionId } = action.context;

  const inst = await loadInstance(instanceRegionId, instanceId);
  if (!inst || inst.ownerType !== 'AVATAR' || inst.ownerId !== String(actorAvatarId)) {
    sendOutput([actorSessionToken], renderOutput("[color=red]You don't have that.[/]"));
    return;
  }

  inst.isState = inst.isState ?? {};
  inst.isState.equipped = wearing;
  await saveInstance(instanceRegionId, instanceId, inst);

  const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { name: true } });
  const name = tmpl?.name ?? 'item';
  sendOutput([actorSessionToken], renderOutput(
    wearing ? `You wear the [b]${_esc(name)}[/].` : `You remove the [b]${_esc(name)}[/].`
  ));
}

function _esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
