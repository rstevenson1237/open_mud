// Panel emission helpers and __panel_submit__ / __panel_cancel__ command handlers.
import { registerCommand } from './commands.js';
import { renderOutput }    from './output.js';
import { redis }           from '../db/redis.js';
import { logger }          from '../log/logger.js';

const PANEL_TTL_SECONDS = 300;

/**
 * Emit a PANEL message to a session's WebSocket.
 * Returns the panelId on success, or null if a panel is already pending.
 */
export async function emitPanel(ws, sessionToken, descriptor) {
  const existing = await redis.keys(`panel:${sessionToken}:panel_*`);
  if (existing.length > 0) return null;

  const panelId = 'panel_' + Math.random().toString(16).slice(2, 10);
  await redis.set(`panel:${sessionToken}:${panelId}`, '1', { EX: PANEL_TTL_SECONDS });

  const message = {
    type: 'PANEL',
    panel: { id: panelId, submitVerb: '__panel_submit__', cancelVerb: '__panel_cancel__', ...descriptor },
  };
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
  return panelId;
}

/**
 * Re-emit a panel with an error message (server-side convenience wrapper).
 */
export async function emitPanelWithError(ws, sessionToken, descriptor, errorMessage) {
  return emitPanel(ws, sessionToken, { ...descriptor, error: errorMessage });
}

async function consumePanelToken(sessionToken, panelId) {
  const key = `panel:${sessionToken}:${panelId}`;
  const exists = await redis.exists(key);
  if (!exists) return false;
  await redis.del(key);
  return true;
}

export function registerPanelHandlers() {
  // __panel_submit__ <panelId> <jsonPayload>
  registerCommand('__panel_submit__', async (ctx) => {
    const raw = ctx.raw.trim();
    const firstSpace = raw.indexOf(' ');
    if (firstSpace < 0) {
      return { output: renderOutput('[color=red]Panel submission malformed: missing panelId.[/]') };
    }
    const rest = raw.slice(firstSpace + 1).trimStart();
    const secondSpace = rest.indexOf(' ');
    if (secondSpace < 0) {
      return { output: renderOutput('[color=red]Panel submission malformed: missing payload.[/]') };
    }
    const panelId = rest.slice(0, secondSpace);
    const jsonStr = rest.slice(secondSpace + 1).trim();

    const valid = await consumePanelToken(ctx.sessionToken, panelId);
    if (!valid) {
      return { output: renderOutput('[color=red]Panel session expired or invalid. Please try the command again.[/]') };
    }

    let payload;
    try {
      payload = JSON.parse(jsonStr);
    } catch {
      return { output: renderOutput('[color=red]Panel submission malformed: invalid JSON payload.[/]') };
    }

    const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
    if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
    const session = JSON.parse(sessionRaw);
    const handlerKey = session.pendingPanelHandler;
    delete session.pendingPanelHandler;
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

    if (!handlerKey || !panelRoutes.has(handlerKey)) {
      logger.warn('PANEL', 'No handler registered for panel', { handlerKey, panelId });
      return { output: renderOutput('[color=red]Panel handler not found.[/]') };
    }

    return panelRoutes.get(handlerKey)(ctx, payload);
  }, { minUserType: 'CHARACTER' });

  // __panel_cancel__ <panelId>
  registerCommand('__panel_cancel__', async (ctx) => {
    const parts = ctx.raw.trim().split(/\s+/);
    const panelId = parts[1];
    if (panelId) await consumePanelToken(ctx.sessionToken, panelId);

    const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
    if (sessionRaw) {
      const session = JSON.parse(sessionRaw);
      delete session.pendingPanelHandler;
      await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
    }
    return { output: renderOutput('[dim]Cancelled.[/]') };
  }, { minUserType: 'CHARACTER' });
}

// Panel route registry: handlerKey → async (ctx, payload) => result
const panelRoutes = new Map();

/**
 * Register a function to handle a panel submission.
 */
export function registerPanelRoute(handlerKey, fn) {
  panelRoutes.set(handlerKey, fn);
}

/**
 * Store the pending panel handler key in session Redis.
 * Call this immediately before emitPanel.
 */
export async function setPendingPanelHandler(sessionToken, handlerKey) {
  const sessionRaw = await redis.get(`session:${sessionToken}`);
  if (!sessionRaw) return;
  const session = JSON.parse(sessionRaw);
  session.pendingPanelHandler = handlerKey;
  await redis.set(`session:${sessionToken}`, JSON.stringify(session));
}
