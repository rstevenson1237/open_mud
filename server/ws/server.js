import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { routeInput } from '../interface/router.js';
import { renderOutput, buildStatusPayload } from '../interface/output.js';
import { initSessionPrng, clearSessionPrng } from '../engine/resolver.js';
import { parseDSL } from '../engine/dsl/parser.js';
import { emitPanel, setPendingPanelHandler } from '../interface/panels.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';
import bcrypt from 'bcryptjs';

const sessions = new Map(); // sessionToken → WebSocket

export function startWsServer(port) {
  const httpServer = createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync('./client/index.html'));
    } else if (req.url === '/terminal.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(readFileSync('./client/terminal.js'));
    } else if (req.url === '/terminal.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(readFileSync('./client/terminal.css'));
    } else if (req.method === 'POST' && req.url?.startsWith('/upload/script')) {
      await handleScriptUpload(req, res);
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

      if (msg.type === 'REGISTER') {
        sessionToken = await handleRegister(ws, msg);
        return;
      }

      if (msg.type === 'CMD' && sessionToken) {
        const session = await loadSession(sessionToken);
        if (!session) { send(ws, { type: 'ERROR', message: 'Session expired.' }); return; }

        const result = await routeInput(msg.input, session);
        if (result.panel) {
          await setPendingPanelHandler(sessionToken, result.panel.handlerKey);
          const panelId = await emitPanel(ws, sessionToken, result.panel.descriptor);
          if (!panelId) {
            send(ws, { type: 'OUTPUT', html: renderOutput('[color=yellow]Please complete or cancel the current panel first.[/]') });
          }
        }
        if (result.output) send(ws, { type: 'OUTPUT', html: result.output });
        if (result.error)  send(ws, { type: 'OUTPUT', html: result.error });
        if (result.status) send(ws, result.status);
        if (result.disconnect) { ws.close(); return; }
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

async function handleScriptUpload(req, res) {
  const jsonErr = (code, msg) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  };

  // Parse query params
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  const attachType = url.searchParams.get('attachType');
  const attachId   = url.searchParams.get('attachId');

  if (!token)      return jsonErr(401, 'Missing ?token=');
  if (!attachType) return jsonErr(400, 'Missing ?attachType= (e.g. LOCATION)');
  if (!attachId)   return jsonErr(400, 'Missing ?attachId= (e.g. regionId:locationId)');

  // Verify session
  const sessionRaw = await redis.get(`session:${token}`);
  if (!sessionRaw) return jsonErr(401, 'Invalid or expired session token.');
  const session = JSON.parse(sessionRaw);

  const UPLOAD_MIN_RANK = ['POWER_USER', 'ADMIN', 'ROOT'];
  if (!UPLOAD_MIN_RANK.includes(session.userType)) {
    return jsonErr(403, 'Insufficient permissions. POWER_USER or above required.');
  }

  // Read body (raw DSL text, max 64 KB)
  const MAX_BYTES = 65536;
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BYTES) { reject(new Error('Payload too large')); }
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  }).catch(e => { jsonErr(413, e.message); return null; });
  if (body === null) return;

  // Parse DSL
  const parsed = parseDSL(body);
  if (!parsed.ok) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'DSL parse errors', details: parsed.errors }));
    return;
  }

  // Save script
  let script = await db.script.findFirst({ where: { attachedToType: attachType, attachedToId: attachId } });
  if (script) {
    script = await db.script.update({ where: { id: script.id }, data: { body: parsed.body } });
  } else {
    script = await db.script.create({ data: { attachedToType: attachType, attachedToId: attachId, body: parsed.body } });
  }

  // Auto-attach to location if LOCATION type
  if (attachType === 'LOCATION') {
    const parts = attachId.split(':');
    const regionId = parseInt(parts[0]);
    const locationId = parseInt(parts[1]);
    if (!isNaN(regionId) && !isNaN(locationId)) {
      await db.location.update({
        where: { regionId_id: { regionId, id: locationId } },
        data: { scriptId: script.id },
      });
    }
  }

  logger.audit('UPLOAD', 'script_upload', { userId: session.userId, attachType, attachId, scriptId: script.id });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, scriptId: script.id, rules: parsed.body.rules?.length ?? 0 }));
}

async function handleAuth(ws, msg) {
  const { username, password } = msg;
  const user = await db.user.findUnique({ where: { username } });
  if (!user) { send(ws, { type: 'AUTH_FAIL', message: 'Unknown user.' }); return null; }

  const valid = user.passwordHash.startsWith('$2')
    ? await bcrypt.compare(password, user.passwordHash)
    : user.passwordHash === password;
  if (!valid) { send(ws, { type: 'AUTH_FAIL', message: 'Invalid credentials.' }); return null; }

  if (user.metadata?.locked) {
    send(ws, { type: 'AUTH_FAIL', message: 'This account has been locked by an administrator.' });
    return null;
  }

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

const USERNAME_RE = /^[A-Za-z0-9_-]{2,30}$/;

async function handleRegister(ws, msg) {
  const { username, password } = msg;

  if (!username || !USERNAME_RE.test(username)) {
    send(ws, { type: 'AUTH_FAIL', message: 'Username must be 2–30 characters (letters, numbers, _ -).' });
    return null;
  }
  if (!password || password.length < 4) {
    send(ws, { type: 'AUTH_FAIL', message: 'Password must be at least 4 characters.' });
    return null;
  }

  const existing = await db.user.findUnique({ where: { username } });
  if (existing) {
    send(ws, { type: 'AUTH_FAIL', message: `Username '${username}' is already taken.` });
    return null;
  }

  const maxRow = await db.user.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  const newId = (maxRow?.id ?? 0) + 1;

  const user = await db.user.create({
    data: {
      id: newId,
      username,
      passwordHash: password,  // Phase 2 replaces with bcrypt
      type: 'CHARACTER',
      aliases: {},
      metadata: {},
    },
  });

  logger.audit('REGISTER', 'user_created', { userId: user.id, username });

  // Log in immediately after registration
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
    userAliases: {},
    connectedAt: Date.now(),
  }));

  initSessionPrng(token);
  sessions.set(token, ws);

  send(ws, { type: 'AUTH_OK', message: renderOutput(`[b]Account created.[/] Welcome, ${username}! Use [b]/new-avatar {name}[/] to create your character.`) });
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
