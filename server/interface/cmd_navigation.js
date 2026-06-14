// Navigation commands: look, go (+ direction aliases), exits, travel, teleport
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { enqueueAction } from '../tick/queue.js';
import { renderLook } from '../engine/navigation.js';
import { db } from '../db/postgres.js';

// Single-letter aliases → canonical direction name
const DIR_ALIASES = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
};

// All directions that map directly (no alias needed) + long forms
const LONG_DIRS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'up', 'down', 'in', 'out'];

export function register() {
  registerCommand('look', handleLook, {
    aliases: ['l'],
    minUserType: 'CHARACTER',
    group: 'navigation',
    description: 'Look at your surroundings',
  });
  registerCommand('exits', handleExits, {
    aliases: [],
    minUserType: 'CHARACTER',
    group: 'navigation',
    description: 'List visible exits',
  });
  registerCommand('go', handleGo, {
    aliases: [...Object.keys(DIR_ALIASES), ...LONG_DIRS],
    minUserType: 'CHARACTER',
    group: 'navigation',
    description: 'Move in a direction',
  });
  registerCommand('travel', handleTravel, {
    aliases: [],
    minUserType: 'CHARACTER',
    group: 'navigation',
    description: 'Travel through a portal',
  });
  registerCommand('teleport', handleTeleport, {
    aliases: ['tp'],
    minUserType: 'POWER_USER',
    group: 'world',
    description: 'Teleport to a location',
  });
}

async function handleLook(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  if (ctx.regionId == null || ctx.locationId == null) {
    return { output: renderOutput('[color=yellow]You float in The Void.[/]') };
  }
  return { output: await renderLook(ctx.regionId, ctx.locationId, ctx.avatarId) };
}

async function handleExits(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  if (ctx.regionId == null || ctx.locationId == null) {
    return { output: renderOutput('[color=yellow]No exits from the void.[/]') };
  }

  const exits = await db.exit.findMany({
    where: { regionId: parseInt(ctx.regionId), fromLocationId: parseInt(ctx.locationId) },
  });
  const visible = exits.filter(e => {
    const is = (e.isState && typeof e.isState === 'object') ? e.isState : {};
    return !is.hidden;
  });

  if (visible.length === 0) return { output: renderOutput('[dim]No visible exits.[/]') };
  return { output: renderOutput(`[b]Exits:[/] ${visible.map(e => e.direction).join(', ')}`) };
}

async function handleGo(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  if (ctx.regionId == null || ctx.locationId == null) {
    return { output: renderOutput('[color=yellow]You float in The Void — nowhere to go.[/]') };
  }

  const parts = ctx.raw.trim().split(/\s+/);
  const verb = parts[0].toLowerCase();

  // Determine direction: if verb is 'go', direction is the first arg; else verb IS the direction
  let rawDir = verb === 'go' ? (parts[1] ?? '').toLowerCase() : verb;
  const direction = DIR_ALIASES[rawDir] ?? rawDir;

  if (!direction) {
    return { output: renderOutput('[b]Usage:[/] go {direction}  (e.g. go north, or just n)') };
  }

  await enqueueAction({
    phase: 1,
    category: 'movement',
    resourceKey: `location:${ctx.regionId}:${ctx.locationId}:${direction}`,
    sessionToken: ctx.sessionToken,
    context: {
      moveType: 'go',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      userId: ctx.userId,
      userType: ctx.userType,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      direction,
    },
  });

  return { output: renderOutput(`[dim]You head ${direction}...[/]`) };
}

async function handleTravel(ctx) {
  return { output: renderOutput('[color=yellow]Portal travel not yet implemented.[/]') };
}

async function handleTeleport(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  // POWER_USER gated (enforced by minUserType in registerCommand).
  // Full implementation in TASK 10 / builder commands.
  return { output: renderOutput('[color=yellow]Teleport not yet implemented.[/]') };
}
