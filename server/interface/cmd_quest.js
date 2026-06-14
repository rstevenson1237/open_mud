// Quest player commands: quests (list), quest accept, quest turn-in
// Builder commands for quests are in cmd_builder.js BUILD_SUBS extension.
import { registerCommand } from './commands.js';
import { registerPanelRoute } from './panels.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { acceptQuest, turnInQuest } from '../engine/quests.js';
import { logger } from '../log/logger.js';

export function register() {
  registerCommand('quests', handleQuests, { aliases: ['quest'], minUserType: 'CHARACTER', group: 'quests', description: 'Manage and view quests' });

  // Builder panel routes
  registerPanelRoute('quest_create',  handleQuestCreateSubmit);
  registerPanelRoute('recipe_create', handleRecipeCreateSubmit);
}

// ─── quests / quest (inline readout + subcommands) ───────────────────────────

async function handleQuests(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase();

  // quest accept {id}
  if (sub === 'accept') {
    const questId = parseInt(parts[2]);
    if (isNaN(questId)) return { output: renderOutput('[b]Usage:[/] quest accept {questId}') };
    const tick = parseInt(await redis.get('world:tickCount') ?? '0');
    const result = await acceptQuest(ctx.avatarId, questId, tick, null, ctx.sessionToken);
    if (!result.ok) return { output: renderOutput(`[color=red]${esc(result.reason)}[/]`) };
    const quest = await db.quest.findUnique({ where: { id: questId }, select: { name: true } });
    return { output: renderOutput(`[color=green]Quest accepted: [b]${esc(quest?.name ?? questId)}[/].[/]`) };
  }

  // quest turn-in {id}
  if (sub === 'turn-in' || sub === 'turnin') {
    const questId = parseInt(parts[2]);
    if (isNaN(questId)) return { output: renderOutput('[b]Usage:[/] quest turn-in {questId}') };
    const tick = parseInt(await redis.get('world:tickCount') ?? '0');
    const result = await turnInQuest(ctx.avatarId, questId, ctx.regionId, tick, null, ctx.sessionToken);
    if (!result.ok) return { output: renderOutput(`[color=red]${esc(result.reason)}[/]`) };
    const quest = await db.quest.findUnique({ where: { id: questId }, select: { name: true } });
    return { output: renderOutput(`[color=green]Quest turned in: [b]${esc(quest?.name ?? questId)}[/]. Rewards granted.[/]`) };
  }

  // quest list (default)
  const avRaw = await redis.get(`avatar:${ctx.avatarId}`);
  if (!avRaw) return { output: renderOutput('[color=red]Avatar not loaded.[/]') };
  const avatar = JSON.parse(avRaw);
  const quests = avatar.quests ?? {};
  const questIds = Object.keys(quests).filter(id => quests[id].status !== 'turned_in');

  if (questIds.length === 0) return { output: renderOutput('[dim]You have no active quests.[/]') };

  let out = '[b]Your Quests:[/]\n';
  for (const questIdStr of questIds) {
    const entry = quests[questIdStr];
    const questDef = await db.quest.findUnique({ where: { id: parseInt(questIdStr) } });
    if (!questDef) continue;
    const statusColor = entry.status === 'complete' ? 'green' : 'white';
    out += `  [color=${statusColor}][b]#${questIdStr} ${esc(questDef.name)}[/][/] [dim](${entry.status})[/]\n`;
    for (const obj of (questDef.objectives ?? [])) {
      const op = entry.objectives[String(obj.id)] ?? { progress: 0, done: false };
      const done = op.done ? '[color=green]✓[/]' : '[dim]○[/]';
      out += `    ${done} ${esc(obj.desc ?? obj.type)} (${op.progress}/${obj.count ?? 1})\n`;
    }
    if (entry.status === 'complete') {
      out += `    [color=green]→ Ready to turn in: quest turn-in ${questIdStr}[/]\n`;
    }
  }
  return { output: renderOutput(out.trimEnd()) };
}

// ─── Builder: build quest / build recipe panels ───────────────────────────────

export async function handleBuildQuest(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const questIdArg = parts[2];
  let existing = null;
  if (questIdArg) {
    const id = parseInt(questIdArg.replace(/^#/, ''));
    if (!isNaN(id)) existing = await db.quest.findUnique({ where: { id } });
  }

  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingQuestTarget = { id: existing?.id ?? null };
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'quest_create',
      descriptor: {
        title: existing ? `Edit Quest #${existing.id}` : 'Create Quest',
        fields: [
          { key: 'name',         type: 'text',     label: 'Name',        default: existing?.name ?? '' },
          { key: 'description',  type: 'textarea', label: 'Description', default: existing?.description ?? '' },
          { key: 'objectives',   type: 'keyvalue-list', label: 'Objectives',
            columns: [
              { key: 'id',     label: 'ID',     type: 'text' },
              { key: 'type',   label: 'Type',   type: 'text' },
              { key: 'target', label: 'Target', type: 'text' },
              { key: 'count',  label: 'Count',  type: 'number', default: 1 },
              { key: 'desc',   label: 'Description', type: 'text' },
            ],
            default: existing?.objectives ?? [],
          },
          { key: 'rewardCoins', type: 'number', label: 'Coin Reward', default: existing?.rewards?.coins ?? 0 },
          { key: 'repeatable',  type: 'checkbox', label: 'Repeatable', default: existing?.repeatable ?? false },
        ],
      },
    },
  };
}

async function handleQuestCreateSubmit(ctx, payload) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const target = session.pendingQuestTarget;
  delete session.pendingQuestTarget;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  const data = {
    name: payload.name?.trim(),
    description: payload.description ?? '',
    objectives: (payload.objectives ?? []).map(o => ({
      id:     o.id,
      type:   o.type,
      target: o.target,
      count:  parseInt(o.count) || 1,
      desc:   o.desc ?? '',
    })),
    rewards: { coins: parseInt(payload.rewardCoins) || 0 },
    repeatable: payload.repeatable ?? false,
  };
  if (!data.name) return { output: renderOutput('[color=red]Quest name is required.[/]') };

  if (target?.id) {
    await db.quest.update({ where: { id: target.id }, data });
    logger.audit('QUESTS', 'quest_updated', { userId: ctx.userId, questId: target.id });
    return { output: renderOutput(`[color=green]Quest #${target.id} updated.[/]`) };
  } else {
    const created = await db.quest.create({ data });
    logger.audit('QUESTS', 'quest_created', { userId: ctx.userId, questId: created.id });
    return { output: renderOutput(`[color=green]Quest #${created.id} '${esc(created.name)}' created.[/]`) };
  }
}

// ─── Builder: build recipe panel ─────────────────────────────────────────────

export async function handleBuildRecipe(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const recipeIdArg = parts[2];
  let existing = null;
  if (recipeIdArg) {
    const id = parseInt(recipeIdArg.replace(/^#/, ''));
    if (!isNaN(id)) existing = await db.recipe.findUnique({ where: { id } });
  }

  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingRecipeTarget = { id: existing?.id ?? null };
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'recipe_create',
      descriptor: {
        title: existing ? `Edit Recipe #${existing.id}` : 'Create Recipe',
        fields: [
          { key: 'name',        type: 'text',     label: 'Name',         default: existing?.name ?? '' },
          { key: 'description', type: 'textarea', label: 'Description',  default: existing?.description ?? '' },
          { key: 'inputs',  type: 'keyvalue-list', label: 'Inputs',
            columns: [
              { key: 'templateId', label: 'Template $ID', type: 'number', min: 1 },
              { key: 'quantity',   label: 'Quantity',     type: 'number', min: 1, default: 1 },
            ],
            default: existing?.inputs ?? [],
          },
          { key: 'outputs', type: 'keyvalue-list', label: 'Outputs',
            columns: [
              { key: 'templateId', label: 'Template $ID', type: 'number', min: 1 },
              { key: 'quantity',   label: 'Quantity',     type: 'number', min: 1, default: 1 },
            ],
            default: existing?.outputs ?? [],
          },
          { key: 'skillId',     type: 'number',   label: 'Required Skill ID (0=none)', default: existing?.skillId ?? 0 },
          { key: 'stationType', type: 'text',     label: 'Station Type (blank=none)', default: existing?.stationType ?? '' },
        ],
      },
    },
  };
}

async function handleRecipeCreateSubmit(ctx, payload) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const target = session.pendingRecipeTarget;
  delete session.pendingRecipeTarget;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  const data = {
    name:        payload.name?.trim(),
    description: payload.description ?? '',
    inputs:  (payload.inputs ?? []).map(r => ({ templateId: parseInt(r.templateId), quantity: parseInt(r.quantity) || 1 })),
    outputs: (payload.outputs ?? []).map(r => ({ templateId: parseInt(r.templateId), quantity: parseInt(r.quantity) || 1 })),
    skillId:     parseInt(payload.skillId) || null,
    stationType: payload.stationType?.trim() || null,
  };
  if (!data.name) return { output: renderOutput('[color=red]Recipe name is required.[/]') };

  if (target?.id) {
    await db.recipe.update({ where: { id: target.id }, data });
    logger.audit('CRAFTING', 'recipe_updated', { userId: ctx.userId, recipeId: target.id });
    return { output: renderOutput(`[color=green]Recipe #${target.id} updated.[/]`) };
  } else {
    const created = await db.recipe.create({ data });
    logger.audit('CRAFTING', 'recipe_created', { userId: ctx.userId, recipeId: created.id });
    return { output: renderOutput(`[color=green]Recipe #${created.id} '${esc(created.name)}' created.[/]`) };
  }
}

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
