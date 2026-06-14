// Resource node engine: harvestHandler and resourceRespawn maintenance task.
// A resource node is an ObjectInstance whose template.baseSchema.resource is set:
//   { yieldTemplateId, yieldCount, respawnTicks, skillId? }
// Registered as system handler 'harvest' and maintenance task 'resourceRespawn' in engine.js.
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { resolve } from './resolver.js';
import { getRollTarget } from './stats.js';
import { allocateInstanceId } from './idAllocator.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function nodeKey(regionId, instanceId) { return `instance:${regionId ?? 'null'}:${instanceId}`; }
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export const harvestHandler = {
  roll(action) {
    const { sessionToken, skillId, actorAvatarId } = action.context ?? {};
    if (!skillId) return resolve(sessionToken, null);
    return (async () => {
      const avRaw = actorAvatarId ? await redis.get(`avatar:${actorAvatarId}`) : null;
      if (!avRaw) return resolve(sessionToken, null);
      const avatar = JSON.parse(avRaw);
      const skillDef = await db.skillDefinition.findUnique({ where: { id: skillId } });
      if (!skillDef) return resolve(sessionToken, null);
      const target = getRollTarget(avatar, skillDef.stat, skillDef.rollContribution);
      return resolve(sessionToken, target);
    })();
  },

  async apply(action, result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    const { sessionToken, actorAvatarId, nodeInstanceId, nodeRegionId, yieldTemplateId, yieldCount, respawnTicks, skillId, regionId, locationId } = ctx;

    // Load node from Redis or DB
    const raw = await redis.get(nodeKey(nodeRegionId, nodeInstanceId));
    const node = raw ? JSON.parse(raw) : await db.objectInstance.findFirst({
      where: { regionId: nodeRegionId, id: nodeInstanceId },
    });
    if (!node) {
      sendOutput([sessionToken], renderOutput('[color=red]That resource is no longer here.[/]'));
      return;
    }

    // Premise: not already depleted
    if (node.isState?.depleted) {
      sendOutput([sessionToken], renderOutput('[color=red]That resource has already been harvested. Wait for it to respawn.[/]'));
      return;
    }

    // Skill gate
    if (skillId && result.outcome === 'fail') {
      sendOutput([sessionToken], renderOutput('[color=red]You fail to harvest anything useful.[/]'));
      return;
    }

    // Yield items to avatar
    const tmpl = await db.objectTemplate.findUnique({ where: { id: yieldTemplateId } });
    const produced = [];
    for (let i = 0; i < (yieldCount ?? 1); i++) {
      const newId = await allocateInstanceId(regionId);
      await db.objectInstance.create({
        data: { id: newId, regionId, templateId: yieldTemplateId, ownerType: 'AVATAR', ownerId: String(actorAvatarId), state: {}, isState: {}, count: tmpl?.type === 'COIN' ? yieldCount : null, metadata: {} },
      });
      await markDirty('instance', `${regionId}:${newId}`);
      produced.push(tmpl?.name ?? `item ${yieldTemplateId}`);
      if (tmpl?.type === 'COIN') break;
    }

    // Mark node depleted
    node.isState = node.isState ?? {};
    node.isState.depleted = true;
    node.state = node.state ?? {};
    node.state.respawnAt = tick + (respawnTicks ?? 20);
    await redis.set(nodeKey(nodeRegionId, nodeInstanceId), JSON.stringify(node));
    await markDirty('instance', `${nodeRegionId ?? 'null'}:${nodeInstanceId}`);

    sendOutput([sessionToken], renderOutput(`[color=green]You harvest: [b]${produced.map(esc).join(', ')}[/].[/]`));
    emit('avatar', String(actorAvatarId), 'on_harvest', { actorAvatarId, yieldTemplateId, regionId, locationId });
    logger.info('RESOURCES', 'harvest', { avatarId: actorAvatarId, yieldTemplateId, nodeInstanceId });
  },
};

// ─── resourceRespawn (maintenance task) ──────────────────────────────────────

export async function resourceRespawn(currentTick, emit) {
  // Scan instance keys for depleted resource nodes whose respawnAt has passed
  const keys = await redis.keys('instance:*');
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const inst = JSON.parse(raw);
    if (!inst.isState?.depleted || !inst.state?.respawnAt) continue;
    if (currentTick < inst.state.respawnAt) continue;

    // Restore node
    inst.isState.depleted = false;
    delete inst.state.respawnAt;
    await redis.set(key, JSON.stringify(inst));

    // Extract regionId:instanceId from key "instance:R:I"
    const parts = key.split(':');
    const regionId = parts[1] === 'null' ? null : parseInt(parts[1]);
    const instanceId = parseInt(parts[2]);
    await markDirty('instance', `${regionId ?? 'null'}:${instanceId}`);

    emit('instance', `${regionId ?? 'null'}:${instanceId}`, 'on_respawn', { regionId, instanceId });
  }
}
