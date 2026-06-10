// Character creation command: /new-avatar {name}
// Implements a two-step interactive wizard stored in session Redis:
//   Step 1 — /new-avatar {name}: validate name, prompt for stat allocation
//   Step 2 — /new-avatar {9 numbers}: apply point-buy, create avatar, activate
// The wizard state is stored in session Redis so the same handler reads it on next invocation.

import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { defaultStats, applyPointBuy, getPointBuyConfig, STAT_KEYS } from '../engine/stats.js';
import { logger } from '../log/logger.js';
// DSL vocab extensions (on_first_visit, has_visited) added in TASK 13 when the
// builder commands that expose parser.js VALID sets are implemented.

const NAME_MIN = 2;
const NAME_MAX = 30;

export function register() {
  registerCommand('new-avatar', handleCreation, {
    aliases: [],
    minUserType: 'CHARACTER',
  });
}

async function handleCreation(ctx) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);

  const args = ctx.raw.trim().split(/\s+/).slice(1); // strip command verb

  // If wizard is active and we receive 9 numbers, process stat allocation (step 2)
  if (session.creationWizard?.step === 'stats' && args.length === 9 && args.every(a => /^-?\d+$/.test(a))) {
    return await _applyStats(ctx, session, args.map(Number));
  }

  // Step 1: name provided
  if (args.length >= 1) {
    return await _validateName(ctx, session, args[0]);
  }

  // No args and no wizard — show help
  if (session.creationWizard?.step === 'stats') {
    return { output: renderOutput(_statPrompt(session.creationWizard.name)) };
  }
  return { output: renderOutput('[b]Usage:[/] /new-avatar {name}') };
}

async function _validateName(ctx, session, name) {
  // Validate printable, length
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { output: renderOutput(`[color=red]Name must be ${NAME_MIN}–${NAME_MAX} characters.[/]`) };
  }
  if (!/^[\x20-\x7E]+$/.test(name)) {
    return { output: renderOutput('[color=red]Name must contain only printable ASCII characters.[/]') };
  }

  // Check uniqueness
  const existing = await db.avatar.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  if (existing) {
    return { output: renderOutput(`[color=red]The name '${_esc(name)}' is already taken.[/]`) };
  }

  // Get point-buy config (no region yet — use world defaults)
  const pbCfg = await getPointBuyConfig(null);

  // Store wizard state in session Redis
  session.creationWizard = {
    step: 'stats',
    name,
    pointBuyConfig: pbCfg,
  };
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  return { output: renderOutput(_statPrompt(name, pbCfg)) };
}

async function _applyStats(ctx, session, nums) {
  const { name, pointBuyConfig: pbCfg } = session.creationWizard;

  // Map 9 numbers to stat keys as final values
  const finalValues = Object.fromEntries(STAT_KEYS.map((k, i) => [k, nums[i]]));

  const base = defaultStats();
  const result = applyPointBuy(base, finalValues, pbCfg);
  if (!result.ok) {
    return { output: renderOutput(`[color=red]${_esc(result.reason)}[/]\n${_statPrompt(name, pbCfg)}`) };
  }

  // Create avatar in DB
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const voidRegionId = world?.config?.voidRegionId ?? null;
  const voidLocationId = world?.config?.voidLocationId ?? null;

  // Generate a unique avatar ID (max existing + 1, min 1)
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

  // Push avatar to Redis hot-state
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
  delete session.creationWizard;
  session.avatarId = avatar.id;
  session.regionId = avatar.regionId;
  session.locationId = avatar.locationId;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  logger.audit('CREATION', 'avatar_created', { avatarId: avatar.id, userId: ctx.userId, name });

  const statSummary = STAT_KEYS.map(k => `${k}:${result.stats[k].value}`).join(' ');
  return {
    output: renderOutput(
      `[b]Avatar '${_esc(name)}' created![/] Welcome to the world.\n` +
      `Stats: ${statSummary}\n` +
      (voidRegionId == null ? 'You float in The Void, awaiting your first step.' : `You find yourself in the starting area.`)
    ),
  };
}

function _statPrompt(name, pbCfg = {}) {
  const budget = pbCfg.majorBudget ?? 30;
  const statMin = pbCfg.statMin ?? 10;
  const statMax = pbCfg.statMax ?? 40;
  return (
    `[b]Creating avatar:[/] ${_esc(name)}\n` +
    `Enter your 9 final stat values. Rules:\n` +
    `  • Each stat: ${statMin}–${statMax}  •  Points above 20 (total): max ${budget}\n` +
    `  • Within each major (PHY/MEN/SOC): free zero-sum shifts up to ±10 per stat\n` +
    `    (reduce one minor to boost another in the same group at no cost)\n` +
    `Order: phy_for phy_pre phy_res  men_for men_pre men_res  soc_for soc_pre soc_res\n` +
    `Example: /new-avatar 30 20 20  25 20 15  20 20 20\n` +
    `(PHY: +10 buy; MEN: +5 buy, −5 free shift; SOC: unchanged)`
  );
}

function _esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
