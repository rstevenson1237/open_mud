// Communication system handler (worker-thread phase 2).
// Registered in engine.js via registerSystemHandler('communication', communicationHandler).
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { resolve } from './resolver.js';
import { hasCondition } from './conditions.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Find all session tokens currently at a given location.
async function getSessionTokensAt(regionId, locationId) {
  const keys = await redis.keys('session:*');
  const tokens = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (s.avatarId && s.regionId === regionId && s.locationId === locationId) {
      tokens.push(s.sessionToken ?? key.slice('session:'.length));
    }
  }
  return tokens;
}

// Find all session tokens with avatars in a given region (any location).
async function getSessionTokensInRegion(regionId) {
  const keys = await redis.keys('session:*');
  const tokens = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (s.avatarId && s.regionId === regionId) {
      tokens.push(s.sessionToken ?? key.slice('session:'.length));
    }
  }
  return tokens;
}

// Find all session tokens with active avatars world-wide.
async function getAllSessionTokens() {
  const keys = await redis.keys('session:*');
  const tokens = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (s.avatarId) tokens.push(s.sessionToken ?? key.slice('session:'.length));
  }
  return tokens;
}

export const communicationHandler = {
  roll(action) {
    return resolve(action.sessionToken, null); // ungated
  },

  async apply(action, result, emit, tick, sendOutput) {
    const { context } = action;
    const { msgType, actorAvatarId, actorSessionToken, regionId, locationId, text } = context;

    // Load actor avatar for name and silenced check
    const raw = await redis.get(`avatar:${actorAvatarId}`);
    const actor = raw ? JSON.parse(raw) : null;
    const actorName = actor?.name ?? 'Someone';

    // say, shout, tell: check silenced
    if (['say', 'shout', 'tell'].includes(msgType)) {
      if (actor && hasCondition(actor, 'silenced')) {
        sendOutput([actorSessionToken], renderOutput('[color=yellow]You cannot speak.[/]'));
        return;
      }
    }

    switch (msgType) {
      case 'say': {
        const tokens = await getSessionTokensAt(regionId, locationId);
        const others = tokens.filter(t => t !== actorSessionToken);
        sendOutput([actorSessionToken], renderOutput(`[dim]You say, "[/]${esc(text)}[dim]"[/]`));
        if (others.length > 0) {
          sendOutput(others, renderOutput(`[b]${esc(actorName)}[/] says, "${esc(text)}"`));
        }
        // Fire on_say trigger on location script (Response phase)
        emit('location', `${regionId}:${locationId}`, 'on_say', {
          regionId, locationId,
          actorAvatarId, actorSessionToken,
          locationSessionTokens: tokens,
          text,
        });
        break;
      }

      case 'whisper': {
        const { targetSessionToken, targetName } = context;
        if (!targetSessionToken) {
          sendOutput([actorSessionToken], renderOutput('[color=red]That person is not here.[/]'));
          break;
        }
        sendOutput([actorSessionToken], renderOutput(`[dim]You whisper to [/][b]${esc(targetName)}[/][dim], "[/]${esc(text)}[dim]"[/]`));
        sendOutput([targetSessionToken], renderOutput(`[b]${esc(actorName)}[/] whispers to you, "${esc(text)}"`));
        break;
      }

      case 'shout': {
        const tokens = await getSessionTokensInRegion(regionId);
        const others = tokens.filter(t => t !== actorSessionToken);
        sendOutput([actorSessionToken], renderOutput(`[dim]You shout, "[/]${esc(text)}[dim]"[/]`));
        if (others.length > 0) {
          sendOutput(others, renderOutput(`[b]${esc(actorName)}[/] shouts, "${esc(text)}"`));
        }
        break;
      }

      case 'tell': {
        const { targetSessionToken, targetName } = context;
        if (!targetSessionToken) {
          sendOutput([actorSessionToken], renderOutput('[color=red]That player is not online.[/]'));
          break;
        }
        sendOutput([actorSessionToken], renderOutput(`[dim]You tell [/][b]${esc(targetName)}[/][dim], "[/]${esc(text)}[dim]"[/]`));
        sendOutput([targetSessionToken], renderOutput(`[b]${esc(actorName)}[/] tells you, "${esc(text)}"`));
        break;
      }

      case 'alert': {
        const { alertScope } = context; // 'world' | regionId[]
        let tokens;
        if (alertScope === 'world') {
          tokens = await getAllSessionTokens();
        } else {
          const regionIds = Array.isArray(alertScope) ? alertScope : [];
          const sets = await Promise.all(regionIds.map(r => getSessionTokensInRegion(r)));
          tokens = [...new Set(sets.flat())];
        }
        sendOutput(tokens, renderOutput(`[color=yellow][b]ALERT:[/] ${esc(text)}[/]`));
        logger.audit('COMMUNICATION', 'alert_sent', { actorAvatarId, alertScope, text });
        break;
      }

      case 'message': {
        // Async mail: stored in DB by command handler inline; nothing to do here.
        break;
      }

      default:
        logger.warn('COMMUNICATION', 'Unknown msgType', { msgType });
    }
  },
};
