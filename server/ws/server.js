import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { routeInput } from '../interface/router.js';
import { renderOutput, buildStatusPayload } from '../interface/output.js';
import { initSessionPrng, clearSessionPrng } from '../engine/resolver.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

const sessions = new Map(); // sessionToken → WebSocket

export function startWsServer(port) {
  const httpServer = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync('./client/index.html'));
    } else if (req.url === '/terminal.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(readFileSync('./client/terminal.js'));
    } else if (req.url === '/terminal.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(readFileSync('./client/terminal.css'));
    } else if (req.method === 'POST' && req.url === '/upload/script') {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Script file upload not yet implemented. Available in Phase 2.' }));
    } else {
      res.writeHead(404); res.end();
    }
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    let sessionToken = null;

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'AUTH') {
        sessionToken = await handleAuth(ws, msg);
        return;
      }

      if (msg.type === 'CMD' && sessionToken) {
        const session = await loadSession(sessionToken);
        if (!session) { send(ws, { type: 'ERROR', message: 'Session expired.' }); return; }

        // editBuffer mode: accumulate lines for multiline script editor
        if (session.editBuffer !== undefined) {
          const line = (msg.input ?? '').trim();
          if (line === '!cancel') {
            delete session.editBuffer;
            delete session.editTarget;
            await redis.set(`session:${sessionToken}`, JSON.stringify(session));
            send(ws, { type: 'OUTPUT', html: renderOutput('[dim]Edit cancelled.[/]') });
          } else if (line === '.') {
            const { finalizeEdit } = await import('../interface/cmd_builder.js');
            const html = await finalizeEdit(session);
            delete session.editBuffer;
            delete session.editTarget;
            await redis.set(`session:${sessionToken}`, JSON.stringify(session));
            send(ws, { type: 'OUTPUT', html });
          } else {
            session.editBuffer.push(line);
            await redis.set(`session:${sessionToken}`, JSON.stringify(session));
            send(ws, { type: 'OUTPUT', html: renderOutput(`[dim]${session.editBuffer.length}:[/] ${line}`) });
          }
          return;
        }

        const result = await routeInput(msg.input, session);
        if (result.output) send(ws, { type: 'OUTPUT', html: result.output });
        if (result.error)  send(ws, { type: 'OUTPUT', html: result.error });
        if (result.status) send(ws, result.status);
        return;
      }
    });

    ws.on('close', async () => {
      if (!sessionToken) return;
      const session = await loadSession(sessionToken);
      if (session?.avatarId) {
        const currentTick = parseInt(await redis.get('world:tickCount') ?? '0');
        await redis.hSet(`session:${sessionToken}`, 'graceTick', currentTick + config.sessionGraceTicks);
        logger.info('WS', 'Client disconnected — grace period started', { sessionToken, graceTick: currentTick + config.sessionGraceTicks });
      }
      sessions.delete(sessionToken);
      clearSessionPrng(sessionToken);
    });
  });

  httpServer.listen(port, () => {
    logger.info('WS', `Server listening on port ${port}`);
  });

  return { wss, sessions };
}

async function handleAuth(ws, msg) {
  const { username, password } = msg;
  const user = await db.user.findUnique({ where: { username } });
  if (!user) { send(ws, { type: 'AUTH_FAIL', message: 'Unknown user.' }); return null; }

  // Phase 1: plain comparison placeholder — Phase 2 implements bcrypt
  const valid = user.passwordHash === password;
  if (!valid) { send(ws, { type: 'AUTH_FAIL', message: 'Invalid credentials.' }); return null; }

  const token = generateToken();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.user.update({ where: { id: user.id }, data: { sessionToken: token, sessionExpiry: expiry } });
  await redis.set(`session:${token}`, JSON.stringify({
    userId: user.id,
    userType: user.type,
    avatarId: null,
    sessionToken: token,
    regionId: null,
    locationId: null,
    userAliases: user.aliases ?? {},
    connectedAt: Date.now(),
  }));

  initSessionPrng(token);
  sessions.set(token, ws);

  send(ws, { type: 'AUTH_OK', message: renderOutput(`[b]Connected.[/] Welcome, ${user.username}.`) });
  logger.info('WS', 'User authenticated', { userId: user.id, userType: user.type });
  return token;
}

async function loadSession(token) {
  const raw = await redis.get(`session:${token}`);
  return raw ? JSON.parse(raw) : null;
}

// Called by tick worker thread messages
export function handleWorkerMessage(msg, sessions) {
  if (msg.type === 'OUTPUT' && msg.sessionToken) {
    const ws = sessions.get(msg.sessionToken);
    if (ws) send(ws, { type: 'OUTPUT', html: msg.html });
  }
  if (msg.type === 'OUTPUT_MULTI' && msg.tokens) {
    for (const token of msg.tokens) {
      const ws = sessions.get(token);
      if (ws) send(ws, { type: 'OUTPUT', html: msg.html });
    }
  }
  if (msg.type === 'ADMIN_ALERT') {
    for (const [token, ws] of sessions) {
      send(ws, { type: 'OUTPUT', html: renderOutput(`[color=yellow][b]ADMIN:[/] ${msg.message}[/]`) });
    }
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function generateToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
