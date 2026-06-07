import { resolveCommand } from './commands.js';
import { checkPermission } from '../engine/permissions.js';
import { redis } from '../db/redis.js';
import { renderOutput } from './output.js';
import { logger } from '../log/logger.js';

const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };

/**
 * Route raw input from a session to either a command handler or the action queue.
 *
 * Input forms:
 *   /command [args]         → command dispatch
 *   verb [args]             → command dispatch (aliases resolved)
 *   // comment              → discard
 *
 * @param {string} raw       Raw input string from client
 * @param {object} session   { userId, userType, avatarId, sessionToken, regionId, locationId }
 * @returns {Promise<{ output?: string, queued?: boolean, error?: string }>}
 */
export async function routeInput(raw, session) {
  const input = raw.trim();

  if (input.startsWith('//')) return { output: null };

  const resolved = await resolveAlias(input, session);

  const cmd = resolveCommand(resolved);
  if (cmd) {
    const effective = session.actingAs ?? session.userType;
    if (TYPE_RANK[effective] < TYPE_RANK[cmd.minUserType]) {
      return { error: renderOutput('[color=red]Permission denied.[/]') };
    }

    const ctx = buildContext(session, resolved);
    try {
      const result = await cmd.handler(ctx);
      return { output: result.output, status: result.status };
    } catch (e) {
      logger.error('ROUTER', 'Command error', { cmd: cmd.verb, error: e.message });
      return { error: renderOutput('[color=red]Command failed.[/]') };
    }
  }

  // Queue as game action for next tick
  await redis.rPush('action:queue', JSON.stringify({
    id: `${session.sessionToken}:${Date.now()}`,
    sessionToken: session.sessionToken,
    trigger: 'on_command',
    category: 'other',
    resourceKey: `location:${session.regionId}:${session.locationId}`,
    context: {
      raw: input,
      userId: session.userId,
      userType: session.userType,
      avatarId: session.avatarId,
      regionId: session.regionId,
      locationId: session.locationId,
    },
  }));

  return { queued: true };
}

async function resolveAlias(input, session) {
  const userRaw = await redis.get(`session:${session.sessionToken}`);
  if (!userRaw) return input;
  const sessionData = JSON.parse(userRaw);
  const aliases = sessionData.userAliases ?? {};
  const verb = input.split(/\s+/)[0].toLowerCase();
  if (aliases[verb]) {
    return aliases[verb] + input.slice(verb.length);
  }
  return input;
}

function buildContext(session, input) {
  return {
    raw: input,
    userId: session.userId,
    userType: session.userType,
    avatarId: session.avatarId,
    sessionToken: session.sessionToken,
    regionId: session.regionId,
    locationId: session.locationId,
    currentTick: null,
  };
}
