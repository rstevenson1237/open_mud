import { resolveCommand } from './commands.js';
import { checkPermission } from '../engine/permissions.js';
import { redis } from '../db/redis.js';
import { renderOutput } from './output.js';
import { logger } from '../log/logger.js';
import { enqueueAction } from '../tick/queue.js';

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

  // Condition intercept — check before processing player input
  const override = await checkInputOverride(session);
  if (override) {
    logger.info('ROUTER', 'Input overridden by condition', {
      avatarId: session.avatarId,
      condition: override.name,
      overrideAction: override.overrideAction,
    });
    if (override.overrideAction) {
      await enqueueAction({
        phase: 1,
        trigger: 'on_command',
        category: 'movement',
        resourceKey: `avatar:${session.avatarId}`,
        context: {
          raw: override.overrideAction,
          userId: session.userId,
          userType: session.userType,
          avatarId: session.avatarId,
          sessionToken: session.sessionToken,
          regionId: session.regionId,
          locationId: session.locationId,
          _overridden: true,
        },
      });
    }
    return { output: null };
  }

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

  // Queue as game action for next tick (phase 3: action)
  await enqueueAction({
    id: `${session.sessionToken}:${Date.now()}`,
    phase: 3,
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
  });

  return { queued: true };
}

async function checkInputOverride(session) {
  if (!session.avatarId) return null;
  const raw = await redis.get(`avatar:${session.avatarId}`);
  if (!raw) return null;
  const avatar = JSON.parse(raw);
  const overriding = (avatar.activeConditions ?? []).find(c => c.overridesInput === true);
  return overriding ?? null;
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
