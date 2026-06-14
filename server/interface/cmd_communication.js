// Communication commands: say, whisper, shout, alert, tell, message
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { enqueueAction } from '../tick/queue.js';
import { checkPermission } from '../engine/permissions.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';

export function register() {
  registerCommand('say',     handleSay,     { aliases: ['"', "'"], minUserType: 'CHARACTER',  group: 'communication', description: 'Speak to the room' });
  registerCommand('whisper', handleWhisper, { aliases: [],          minUserType: 'CHARACTER',  group: 'communication', description: 'Whisper to someone here' });
  registerCommand('shout',   handleShout,   { aliases: [],          minUserType: 'CHARACTER',  group: 'communication', description: 'Shout across the region' });
  registerCommand('alert',   handleAlert,   { aliases: [],          minUserType: 'POWER_USER', group: 'world',         description: 'Broadcast a system alert' });
  registerCommand('tell',    handleTell,    { aliases: [],          minUserType: 'CHARACTER',  group: 'communication', description: 'Send a direct message' });
  registerCommand('message', handleMessage, { aliases: ['mail'],    minUserType: 'CHARACTER',  group: 'communication', description: 'Leave an inbox message' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(raw, wordsToStrip) {
  const parts = raw.trim().split(/\s+/);
  return parts.slice(wordsToStrip).join(' ').trim();
}

// Resolve @name or name → { avatarId, sessionToken, name } | null
async function resolveOnlineTarget(nameArg) {
  const name = nameArg.startsWith('@') ? nameArg.slice(1) : nameArg;
  const avatar = await db.avatar.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, isActive: true },
    select: { id: true, name: true, userId: true },
  });
  if (!avatar) return null;
  const user = await db.user.findUnique({
    where: { id: avatar.userId },
    select: { sessionToken: true },
  });
  if (!user?.sessionToken) return null;
  // Verify session is live in Redis
  const sessionRaw = await redis.get(`session:${user.sessionToken}`);
  if (!sessionRaw) return null;
  return { avatarId: avatar.id, sessionToken: user.sessionToken, name: avatar.name };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSay(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const text = extractText(ctx.raw, 1);
  if (!text) return { output: renderOutput('[b]Usage:[/] say {text}') };

  await enqueueAction({
    phase: 2, category: 'communication',
    sessionToken: ctx.sessionToken,
    context: {
      msgType: 'say',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      text,
    },
  });
  return { output: null };
}

async function handleWhisper(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  // whisper @target some text
  if (parts.length < 3) return { output: renderOutput('[b]Usage:[/] whisper @target {text}') };

  const text = parts.slice(2).join(' ');
  const target = await resolveOnlineTarget(parts[1]);

  // Verify target is in same location
  let targetInLoc = false;
  let targetSessionToken = null;
  let targetName = parts[1].replace(/^@/, '');
  if (target) {
    const tSessionRaw = await redis.get(`session:${target.sessionToken}`);
    const tSession = tSessionRaw ? JSON.parse(tSessionRaw) : null;
    if (tSession?.regionId === ctx.regionId && tSession?.locationId === ctx.locationId) {
      targetInLoc = true;
      targetSessionToken = target.sessionToken;
      targetName = target.name;
    }
  }

  await enqueueAction({
    phase: 2, category: 'communication',
    sessionToken: ctx.sessionToken,
    context: {
      msgType: 'whisper',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      targetSessionToken: targetInLoc ? targetSessionToken : null,
      targetName,
      text,
    },
  });
  return { output: null };
}

async function handleShout(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const text = extractText(ctx.raw, 1);
  if (!text) return { output: renderOutput('[b]Usage:[/] shout {text}') };

  await enqueueAction({
    phase: 2, category: 'communication',
    sessionToken: ctx.sessionToken,
    context: {
      msgType: 'shout',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      text,
    },
  });
  return { output: null };
}

async function handleAlert(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const text = extractText(ctx.raw, 1);
  if (!text) return { output: renderOutput('[b]Usage:[/] alert {text}') };

  // Determine scope: ADMIN/ROOT → world; POWER_USER → owned regions
  const userType = ctx.userType;
  let alertScope;
  if (userType === 'ROOT' || userType === 'ADMIN') {
    const allowed = await checkPermission({
      subjectType: 'user', subjectId: String(ctx.userId),
      objectType: 'world', objectId: '0',
      action: 'alert',
    }, { userType });
    if (!allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };
    alertScope = 'world';
  } else {
    // POWER_USER: only their owned regions
    const owned = await db.region.findMany({
      where: { ownerUserId: ctx.userId },
      select: { id: true },
    });
    if (owned.length === 0) return { output: renderOutput('[color=red]You own no regions to alert.[/]') };
    alertScope = owned.map(r => r.id);
  }

  await enqueueAction({
    phase: 2, category: 'communication',
    sessionToken: ctx.sessionToken,
    context: {
      msgType: 'alert',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      alertScope,
      text,
    },
  });
  return { output: null };
}

async function handleTell(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  if (parts.length < 3) return { output: renderOutput('[b]Usage:[/] tell @target {text}') };

  const text = parts.slice(2).join(' ');
  const target = await resolveOnlineTarget(parts[1]);

  await enqueueAction({
    phase: 2, category: 'communication',
    sessionToken: ctx.sessionToken,
    context: {
      msgType: 'tell',
      actorAvatarId: ctx.avatarId,
      actorSessionToken: ctx.sessionToken,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
      targetSessionToken: target?.sessionToken ?? null,
      targetName: target?.name ?? parts[1].replace(/^@/, ''),
      text,
    },
  });
  return { output: null };
}

async function handleMessage(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  // Usage: message @target {subject}: {body}
  // Simplified parse: message @target subject text…
  const parts = ctx.raw.trim().split(/\s+/);
  if (parts.length < 4) {
    return { output: renderOutput('[b]Usage:[/] message @target {subject} {body}') };
  }
  const targetArg = parts[1];
  const subject = parts[2];
  const body = parts.slice(3).join(' ');

  // Resolve target user (not just online — mail works offline)
  const targetName = targetArg.startsWith('@') ? targetArg.slice(1) : targetArg;
  const targetAvatar = await db.avatar.findFirst({
    where: { name: { equals: targetName, mode: 'insensitive' } },
    select: { id: true, name: true, userId: true },
  });
  if (!targetAvatar) {
    return { output: renderOutput(`[color=red]No avatar named '${targetName}' found.[/]`) };
  }

  // Check inbox cap (50 messages)
  const inboxCount = await db.message.count({ where: { toUserId: targetAvatar.userId } });
  const targetUser = await db.user.findUnique({ where: { id: targetAvatar.userId }, select: { inboxLimit: true } });
  const limit = targetUser?.inboxLimit ?? 50;
  if (inboxCount >= limit) {
    return { output: renderOutput(`[color=red]${targetAvatar.name}'s inbox is full.[/]`) };
  }

  // Get sender's userId
  await db.message.create({
    data: {
      fromUserId: ctx.userId,
      toUserId: targetAvatar.userId,
      fromAvatarId: ctx.avatarId,
      toAvatarId: targetAvatar.id,
      subject,
      body,
    },
  });

  return { output: renderOutput(`[dim]Message sent to [/][b]${targetAvatar.name}[/][dim].[/]`) };
}
