// Quest engine — reactive objective evaluation and reward dispatch.
// questHook is called once per drained Response event in engine.js.
// questActionDispatch handles grant_quest / complete_quest from the state machine.
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { allocateInstanceId } from './idAllocator.js';
import { grantSkill } from './skills.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── Event → objective mapping ────────────────────────────────────────────────

const OBJECTIVE_EVENTS = {
  on_kill:     'kill',
  on_take:     'collect',
  on_purchase: 'collect',
  on_craft:    'collect',
  on_harvest:  'collect',
  on_enter:    'visit',
  on_give:     'deliver',
};

export async function questHook(eventName, context, tick, emit, sendOutput) {
  const objectiveType = OBJECTIVE_EVENTS[eventName];
  if (!objectiveType) return;

  const avatarId = context.actorAvatarId;
  if (!avatarId) return;

  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return;
  const avatar = JSON.parse(avRaw);
  const quests = avatar.quests ?? {};
  let dirty = false;

  for (const [questIdStr, progress] of Object.entries(quests)) {
    if (progress.status !== 'active') continue;
    const questDef = await db.quest.findUnique({ where: { id: parseInt(questIdStr) } });
    if (!questDef) continue;

    for (const obj of (questDef.objectives ?? [])) {
      if (obj.type !== objectiveType) continue;
      const objProgress = progress.objectives[String(obj.id)] ?? { progress: 0, done: false };
      if (objProgress.done) continue;

      let updated = false;

      if (objectiveType === 'kill') {
        // killed instance's templateId matches target
        const killedTemplateId = context.templateId ?? context.targetTemplateId;
        if (String(killedTemplateId) === String(obj.target)) {
          objProgress.progress = Math.min((objProgress.progress ?? 0) + 1, obj.count ?? 1);
          updated = true;
        }
      } else if (objectiveType === 'collect') {
        // count currently-held instances of target templateId
        const templateId = parseInt(obj.target);
        const held = await db.objectInstance.findMany({
          where: { templateId, ownerType: 'AVATAR', ownerId: String(avatarId) },
          include: { template: { select: { type: true } } },
        });
        const total = held.reduce((s, i) => s + (i.template.type === 'COIN' ? (i.count ?? 1) : 1), 0);
        objProgress.progress = Math.min(total, obj.count ?? 1);
        updated = true;
      } else if (objectiveType === 'visit') {
        // target = regionId
        if (String(context.regionId) === String(obj.target)) {
          objProgress.progress = 1;
          updated = true;
        }
      } else if (objectiveType === 'deliver') {
        // target = "${npcTemplateId}:${itemTemplateId}"
        const [npcTplId, itemTplId] = String(obj.target).split(':');
        const targetNpcTemplateId = context.targetTemplateId ?? context.npcTemplateId;
        const givenTemplateId = context.templateId;
        if (String(targetNpcTemplateId) === npcTplId && String(givenTemplateId) === itemTplId) {
          objProgress.progress = 1;
          updated = true;
        }
      }

      if (updated) {
        objProgress.done = objProgress.progress >= (obj.count ?? 1);
        progress.objectives[String(obj.id)] = objProgress;
        dirty = true;
      }
    }

    // Check if all objectives are done
    if (dirty) {
      const allDone = (questDef.objectives ?? []).every(obj => progress.objectives[String(obj.id)]?.done);
      if (allDone && progress.status === 'active') {
        progress.status = 'complete';
        const notifyMsg = renderOutput(`[color=green]Quest '[b]${esc(questDef.name)}[/]' is ready to turn in. Use [b]quest turn-in ${questDef.id}[/].[/]`);
        // Notify via session lookup
        const user = await db.user.findFirst({
          where: { avatars: { some: { id: avatarId } } },
          select: { sessionToken: true },
        });
        if (user?.sessionToken) sendOutput([user.sessionToken], notifyMsg);
        emit('avatar', String(avatarId), 'on_quest_complete', { avatarId, questId: questDef.id });
      }
      quests[questIdStr] = progress;
    }
  }

  if (dirty) {
    avatar.quests = quests;
    await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
    await markDirty('avatar', avatarId);
  }
}

// ─── Quest accept / turn-in helpers (used by cmd_quest.js) ───────────────────

export async function acceptQuest(avatarId, questId, tick, sendOutput, sessionToken) {
  const questDef = await db.quest.findUnique({ where: { id: parseInt(questId) } });
  if (!questDef) return { ok: false, reason: `Quest #${questId} not found.` };

  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return { ok: false, reason: 'Avatar not loaded.' };
  const avatar = JSON.parse(avRaw);
  const quests = avatar.quests ?? {};

  // Prerequisite check
  for (const prereqId of (questDef.prerequisites ?? [])) {
    if (quests[String(prereqId)]?.status !== 'turned_in') {
      const prereq = await db.quest.findUnique({ where: { id: prereqId }, select: { name: true } });
      return { ok: false, reason: `Prerequisite not met: '${prereq?.name ?? prereqId}' must be turned in first.` };
    }
  }

  // Already active/complete
  const existing = quests[String(questId)];
  if (existing && !questDef.repeatable) {
    if (existing.status === 'turned_in') return { ok: false, reason: 'Quest already completed.' };
    if (existing.status === 'active' || existing.status === 'complete') return { ok: false, reason: 'Quest already in progress.' };
  }

  // Region scope
  if (questDef.regionScoped) {
    const region = avatar.regionId ? await db.region.findUnique({ where: { id: avatar.regionId } }) : null;
    const regionQuests = region?.config?.questIds ?? [];
    if (!regionQuests.includes(parseInt(questId))) {
      return { ok: false, reason: 'That quest is not available in this region.' };
    }
  }

  // Initialize progress
  const objectives = {};
  for (const obj of (questDef.objectives ?? [])) {
    objectives[String(obj.id)] = { progress: 0, done: false };
  }
  quests[String(questId)] = { status: 'active', objectives, startedAt: tick };
  avatar.quests = quests;
  await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', avatarId);

  logger.info('QUESTS', 'quest_accepted', { avatarId, questId });
  return { ok: true };
}

export async function turnInQuest(avatarId, questId, regionId, tick, sendOutput, sessionToken) {
  const questDef = await db.quest.findUnique({ where: { id: parseInt(questId) } });
  if (!questDef) return { ok: false, reason: `Quest #${questId} not found.` };

  const avRaw = await redis.get(`avatar:${avatarId}`);
  if (!avRaw) return { ok: false, reason: 'Avatar not loaded.' };
  const avatar = JSON.parse(avRaw);
  const quests = avatar.quests ?? {};
  const entry = quests[String(questId)];

  if (!entry || entry.status !== 'complete') {
    return { ok: false, reason: 'Quest is not complete yet.' };
  }

  const rewards = questDef.rewards ?? {};

  // Coin reward
  if (rewards.coins > 0) {
    await _addCoins(avatarId, rewards.coins, regionId);
  }

  // Item rewards
  for (const reward of (rewards.items ?? [])) {
    const newId = await allocateInstanceId(regionId);
    await db.objectInstance.create({
      data: {
        id: newId, regionId, templateId: reward.templateId,
        ownerType: 'AVATAR', ownerId: String(avatarId),
        count: reward.quantity ?? 1, state: {}, isState: {}, metadata: {},
      },
    });
    await markDirty('instance', `${regionId}:${newId}`);
  }

  // Skill rewards
  for (const skillId of (rewards.skillIds ?? [])) {
    await grantSkill('avatar', avatarId, skillId, { regionId });
  }

  // Update status
  if (questDef.repeatable) {
    delete quests[String(questId)]; // allow re-accept
  } else {
    quests[String(questId)].status = 'turned_in';
  }
  avatar.quests = quests;
  await redis.set(`avatar:${avatarId}`, JSON.stringify(avatar));
  await markDirty('avatar', avatarId);

  logger.info('QUESTS', 'quest_turned_in', { avatarId, questId });
  return { ok: true };
}

// ─── DSL action dispatch (grant_quest / complete_quest from state machine) ────

export async function questActionDispatch(fn, args, context, emitOutput, emitEvent) {
  const avatarId = args[0] === '$actor' ? context.actorAvatarId : parseInt(args[0]);
  const questId = parseInt(args[1]);
  if (!avatarId || isNaN(questId)) return;

  const tick = context.currentTick ?? 0;

  if (fn === 'grant_quest') {
    const result = await acceptQuest(avatarId, questId, tick, null, null);
    if (!result.ok) logger.warn('QUESTS', 'grant_quest failed', { avatarId, questId, reason: result.reason });
    else emitEvent('avatar', String(avatarId), 'on_quest_accept', { avatarId, questId });
  } else if (fn === 'complete_quest') {
    const result = await turnInQuest(avatarId, questId, context.regionId, tick, null, null);
    if (!result.ok) logger.warn('QUESTS', 'complete_quest failed', { avatarId, questId, reason: result.reason });
    else emitEvent('avatar', String(avatarId), 'on_quest_complete', { avatarId, questId });
  }
}

// ─── Coin helper ──────────────────────────────────────────────────────────────

async function _addCoins(avatarId, amount, regionId) {
  const coinInsts = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { type: true } } },
  });
  const coin = coinInsts.find(c => c.template?.type === 'COIN');
  if (coin) {
    await db.objectInstance.update({
      where: { regionId_id: { regionId: coin.regionId, id: coin.id } },
      data: { count: (coin.count ?? 1) + amount },
    });
  } else {
    const tmpl = await db.objectTemplate.findFirst({ where: { regionId, type: 'COIN' } })
      ?? await db.objectTemplate.findFirst({ where: { type: 'COIN' } });
    if (!tmpl) return;
    const newId = await allocateInstanceId(regionId);
    await db.objectInstance.create({
      data: { id: newId, regionId, templateId: tmpl.id, ownerType: 'AVATAR', ownerId: String(avatarId), count: amount, state: {}, isState: {}, metadata: {} },
    });
  }
}
