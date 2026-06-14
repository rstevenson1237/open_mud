// Character creation command: /new-avatar {name} [stat values...]
// Decision fork:
//   All 10 args inline  → execute immediately, no panel
//   Name only           → validate name inline, open stat panel with name locked
//   No args             → open panel with empty name field

import { registerCommand } from './commands.js';
import { registerPanelRoute } from './panels.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { defaultStats, applyPointBuy, getPointBuyConfig, STAT_KEYS } from '../engine/stats.js';
import { logger } from '../log/logger.js';

const NAME_MIN = 2;
const NAME_MAX = 30;

export function register() {
  registerCommand('new-avatar', handleCreation, {
    aliases: [],
    minUserType: 'CHARACTER',
    group: 'character',
    description: 'Create a new avatar',
  });

  registerPanelRoute('new_avatar_stats', handleAvatarPanelSubmit);
}

async function handleCreation(ctx) {
  const args = ctx.raw.trim().split(/\s+/).slice(1);

  // Inline bypass: name + 9 stat values provided
  if (args.length >= 10) {
    const name = args[0];
    const nums = args.slice(1, 10).map(Number);
    if (nums.every(n => !isNaN(n))) {
      const nameErr = await _checkName(name);
      if (nameErr) return { output: renderOutput(nameErr) };
      return _applyStats(ctx, name, nums);
    }
  }

  // Name only: validate then open panel with name locked
  if (args.length >= 1) {
    const name = args[0];
    const nameErr = await _checkName(name);
    if (nameErr) return { output: renderOutput(nameErr) };

    const pbCfg = await getPointBuyConfig(null);
    return _openCreationPanel(name, pbCfg, true);
  }

  // No args: open panel with empty name field
  const pbCfg = await getPointBuyConfig(null);
  return _openCreationPanel(null, pbCfg, false);
}

function _openCreationPanel(name, pbCfg, nameLocked) {
  return {
    panel: {
      handlerKey: 'new_avatar_stats',
      descriptor: {
        title: 'Create Avatar',
        description: 'Choose your name and allocate your starting stats.',
        fields: [
          {
            key: 'name',
            type: 'text',
            label: 'Avatar Name',
            minLength: NAME_MIN,
            maxLength: NAME_MAX,
            pattern: '^[\\x20-\\x7E]+$',
            default: name ?? '',
            locked: nameLocked,
            helpText: 'Printable ASCII, 2–30 characters. Must be unique.',
          },
          {
            key: 'stats',
            type: 'stat-allocator',
            label: 'Stat Allocation',
            majorBudget: pbCfg.majorBudget,
            statMin: pbCfg.statMin,
            statMax: pbCfg.statMax,
            helpText: `Points above 20 per stat cost from your budget of ${pbCfg.majorBudget}.`,
          },
        ],
      },
    },
  };
}

async function handleAvatarPanelSubmit(ctx, payload) {
  const { name, stats } = payload;

  // Re-validate name (it may not have been pre-validated if entered in panel)
  const nameErr = await _checkName(name);
  if (nameErr) {
    const pbCfg = await getPointBuyConfig(null);
    return {
      panel: {
        handlerKey: 'new_avatar_stats',
        descriptor: {
          ..._openCreationPanel(name, pbCfg, false).panel.descriptor,
          error: nameErr.replace(/\[.*?\]/g, ''),
        },
      },
    };
  }

  // Map stat object to ordered array
  const nums = STAT_KEYS.map(k => stats?.[k] ?? 20);
  return _applyStats(ctx, name, nums);
}

async function _checkName(name) {
  if (!name || name.length < NAME_MIN || name.length > NAME_MAX) {
    return `[color=red]Name must be ${NAME_MIN}–${NAME_MAX} characters.[/]`;
  }
  if (!/^[\x20-\x7E]+$/.test(name)) {
    return '[color=red]Name must contain only printable ASCII characters.[/]';
  }
  const existing = await db.avatar.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (existing) {
    return `[color=red]The name '${_esc(name)}' is already taken.[/]`;
  }
  return null;
}

async function _applyStats(ctx, name, nums) {
  const pbCfg = await getPointBuyConfig(null);
  const finalValues = Object.fromEntries(STAT_KEYS.map((k, i) => [k, nums[i]]));
  const base = defaultStats();
  const result = applyPointBuy(base, finalValues, pbCfg);
  if (!result.ok) {
    return { output: renderOutput(`[color=red]${_esc(result.reason)}[/]`) };
  }

  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const voidRegionId = world?.config?.voidRegionId ?? null;
  const voidLocationId = world?.config?.voidLocationId ?? null;

  const maxRow = await db.avatar.findFirst({ orderBy: { id: 'desc' } });
  const newId = (maxRow?.id ?? 0) + 1;

  const avatar = await db.avatar.create({
    data: {
      id: newId,
      userId: ctx.userId,
      name,
      regionId: voidRegionId,
      locationId: voidLocationId,
      stats: result.stats,
      skills: {},
      wounds: 0,
      sanity: 0,
      stress: 1,
      visitedRegions: [],
      isActive: true,
      metadata: {},
    },
  });

  const hotState = {
    id: avatar.id,
    userId: avatar.userId,
    name: avatar.name,
    regionId: avatar.regionId,
    locationId: avatar.locationId,
    stats: avatar.stats,
    skills: avatar.skills,
    wounds: avatar.wounds,
    sanity: avatar.sanity,
    stress: avatar.stress,
    hunger: avatar.hunger,
    rest: avatar.rest,
    woundMax: avatar.woundMax,
    sanityMax: avatar.sanityMax,
    carryCapacity: avatar.carryCapacity,
    encumberedThreshold: avatar.encumberedThreshold,
    activeConditions: [],
    visitedRegions: [],
    isActive: true,
    metadata: {},
    state: {},
    isState: {},
  };
  await redis.set(`avatar:${avatar.id}`, JSON.stringify(hotState));
  await markDirty('avatar', avatar.id);

  // Activate: update session to reference this avatar
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.avatarId = avatar.id;
    session.regionId = avatar.regionId;
    session.locationId = avatar.locationId;
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  logger.audit('CREATION', 'avatar_created', { avatarId: avatar.id, userId: ctx.userId, name });

  const statSummary = STAT_KEYS.map(k => `${k}:${result.stats[k].value}`).join(' ');
  return {
    output: renderOutput(
      `[b]Avatar '${_esc(name)}' created![/] Welcome to the world.\n` +
      `Stats: ${statSummary}\n` +
      (voidRegionId == null ? 'You float in The Void, awaiting your first step.' : 'You find yourself in the starting area.')
    ),
  };
}

function _esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
