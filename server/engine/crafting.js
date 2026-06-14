// Crafting engine: craftingHandler for phase 3 action resolution.
// Registered as system handler 'craft' in engine.js.
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { resolve } from './resolver.js';
import { getRollTarget } from './stats.js';
import { allocateInstanceId } from './idAllocator.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── Roll helper ──────────────────────────────────────────────────────────────

async function _craftRoll(action) {
  const { sessionToken, recipeId } = action.context ?? {};
  const recipe = await db.recipe.findUnique({ where: { id: recipeId } });
  if (!recipe?.skillId) return resolve(sessionToken, null); // ungated

  const actorAvatarId = action.context?.actorAvatarId;
  const avRaw = actorAvatarId ? await redis.get(`avatar:${actorAvatarId}`) : null;
  if (!avRaw) return resolve(sessionToken, null);
  const avatar = JSON.parse(avRaw);

  const skillDef = await db.skillDefinition.findUnique({ where: { id: recipe.skillId } });
  if (!skillDef) return resolve(sessionToken, null);

  const target = getRollTarget(avatar, skillDef.stat, skillDef.rollContribution);
  return resolve(sessionToken, target);
}

// ─── craftingHandler ─────────────────────────────────────────────────────────

export const craftingHandler = {
  roll: _craftRoll,

  async apply(action, result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    const { sessionToken, actorAvatarId, recipeId, regionId, locationId } = ctx;

    const recipe = await db.recipe.findUnique({ where: { id: recipeId } });
    if (!recipe) {
      sendOutput([sessionToken], renderOutput('[color=red]Recipe no longer exists.[/]'));
      return;
    }

    const avRaw = await redis.get(`avatar:${actorAvatarId}`);
    if (!avRaw) return;
    const avatar = JSON.parse(avRaw);

    // Station check
    if (recipe.stationType) {
      const atLoc = await db.objectInstance.findMany({
        where: { regionId, ownerType: 'LOCATION', ownerId: String(locationId) },
        include: { template: { select: { type: true, baseSchema: true } } },
      });
      const hasStation = atLoc.some(i =>
        i.template.type === recipe.stationType ||
        i.template.baseSchema?.stationType === recipe.stationType
      );
      if (!hasStation) {
        sendOutput([sessionToken], renderOutput(`[color=red]You need a [b]${esc(recipe.stationType)}[/] station here to craft this.[/]`));
        return;
      }
    }

    // Skill check: if the recipe has a skillId, the avatar must have it
    if (recipe.skillId) {
      const skills = avatar.skills ?? {};
      if (!skills[String(recipe.skillId)]?.acquired) {
        const skillDef = await db.skillDefinition.findUnique({ where: { id: recipe.skillId } });
        sendOutput([sessionToken], renderOutput(`[color=red]You need the [b]${esc(skillDef?.name ?? 'required skill')}[/] to craft this.[/]`));
        return;
      }
    }

    // Gather avatar inventory
    const inventory = await db.objectInstance.findMany({
      where: { ownerType: 'AVATAR', ownerId: String(actorAvatarId) },
      include: { template: { select: { type: true, name: true } } },
    });

    // Verify inputs are available
    const inputs = recipe.inputs ?? [];
    const missing = [];
    const toConsume = [];

    for (const req of inputs) {
      const tplId = req.templateId;
      const needed = req.quantity ?? 1;
      const isCoin = inventory.find(i => i.templateId === tplId && i.template.type === 'COIN');

      if (isCoin) {
        const total = inventory.filter(i => i.template.type === 'COIN').reduce((s, i) => s + (i.count ?? 1), 0);
        if (total < needed) {
          const tmpl = await db.objectTemplate.findUnique({ where: { id: tplId }, select: { name: true } });
          missing.push(`${needed} ${tmpl?.name ?? `template ${tplId}`} (have ${total})`);
        } else {
          toConsume.push({ type: 'coins', amount: needed, instances: inventory.filter(i => i.template.type === 'COIN') });
        }
      } else {
        const held = inventory.filter(i => i.templateId === tplId);
        if (held.length < needed) {
          const tmpl = await db.objectTemplate.findUnique({ where: { id: tplId }, select: { name: true } });
          missing.push(`${needed}x ${tmpl?.name ?? `template ${tplId}`} (have ${held.length})`);
        } else {
          toConsume.push({ type: 'items', instances: held.slice(0, needed) });
        }
      }
    }

    if (missing.length > 0) {
      sendOutput([sessionToken], renderOutput(`[color=red]Missing ingredients:[/] ${missing.map(esc).join(', ')}`));
      return;
    }

    // Gated failure: consume nothing, bump stress
    if (result.outcome === 'fail') {
      const shouldConsume = recipe.metadata?.consumeOnFail === true;
      if (!shouldConsume) {
        const newStress = Math.min(20, (avatar.stress ?? 0) + 1);
        avatar.stress = newStress;
        await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
        await markDirty('avatar', actorAvatarId);
        sendOutput([sessionToken], renderOutput('[color=red]Your attempt fails.[/]'));
        return;
      }
    }

    // Consume inputs
    for (const entry of toConsume) {
      if (entry.type === 'coins') {
        let remaining = entry.amount;
        for (const c of entry.instances) {
          if (remaining <= 0) break;
          const take = Math.min(c.count ?? 1, remaining);
          remaining -= take;
          const newCount = (c.count ?? 1) - take;
          if (newCount <= 0) {
            await db.objectInstance.delete({ where: { regionId_id: { regionId: c.regionId, id: c.id } } });
          } else {
            await db.objectInstance.update({ where: { regionId_id: { regionId: c.regionId, id: c.id } }, data: { count: newCount } });
          }
        }
      } else {
        for (const inst of entry.instances) {
          await db.objectInstance.delete({ where: { regionId_id: { regionId: inst.regionId, id: inst.id } } });
        }
      }
    }

    // Produce outputs
    const outputs = recipe.outputs ?? [];
    const carryWeight = avatar.state?.carryWeight ?? 0;
    const cap = avatar.carryCapacity ?? 100;
    let currentWeight = carryWeight;
    const produced = [];
    const dropped = [];

    for (const out of outputs) {
      const tmpl = await db.objectTemplate.findUnique({ where: { id: out.templateId } });
      if (!tmpl) continue;
      const qty = out.quantity ?? 1;

      for (let i = 0; i < qty; i++) {
        const weight = tmpl.type === 'COIN' ? 0 : (tmpl.weight ?? 1);
        const newId = await allocateInstanceId(regionId);

        if (currentWeight + weight <= cap) {
          await db.objectInstance.create({
            data: { id: newId, regionId, templateId: out.templateId, ownerType: 'AVATAR', ownerId: String(actorAvatarId), state: {}, isState: {}, count: tmpl.type === 'COIN' ? qty : null, metadata: {} },
          });
          await markDirty('instance', `${regionId}:${newId}`);
          currentWeight += weight;
          produced.push(tmpl.name);
          if (tmpl.type === 'COIN') break; // COIN template handles qty via count
        } else {
          // Overflow: drop to location
          await db.objectInstance.create({
            data: { id: newId, regionId, templateId: out.templateId, ownerType: 'LOCATION', ownerId: String(locationId), state: {}, isState: {}, count: tmpl.type === 'COIN' ? qty : null, metadata: {} },
          });
          dropped.push(tmpl.name);
          if (tmpl.type === 'COIN') break;
        }
      }
    }

    // Update carry weight in avatar hot-state
    avatar.state = avatar.state ?? {};
    avatar.state.carryWeight = currentWeight;
    await redis.set(`avatar:${actorAvatarId}`, JSON.stringify(avatar));
    await markDirty('avatar', actorAvatarId);

    let msg = `[color=green]You craft: [b]${produced.map(esc).join(', ')}[/].[/]`;
    if (dropped.length > 0) {
      msg += ` [color=yellow](${dropped.map(esc).join(', ')} dropped to the floor — carry limit reached)[/]`;
    }
    sendOutput([sessionToken], renderOutput(msg));

    emit('avatar', String(actorAvatarId), 'on_craft', {
      actorAvatarId, recipeId, outputs: produced,
      regionId, locationId,
    });
    logger.info('CRAFTING', 'craft', { avatarId: actorAvatarId, recipeId, produced });
  },
};
