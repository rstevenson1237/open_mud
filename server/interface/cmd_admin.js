// Admin & root command suite.
// admin {user|avatar} {subcommand} [args...]  — requires ADMIN+ (guardrailed)
// root  {set-user|set-world}      [args...]  — requires ROOT (direct access)

import { registerCommand } from './commands.js';
import { registerPanelRoute } from './panels.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';
import { grantSkill, revokeSkill } from '../engine/skills.js';
import { defaultStats, STAT_KEYS } from '../engine/stats.js';

const VALID_USER_TYPES = ['CHARACTER', 'GHOST', 'POWER_USER', 'ADMIN', 'ROOT'];
const ADMIN_MAX_SET_TYPE = 'POWER_USER'; // ADMINs cannot escalate beyond this
const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };

export function register() {
  registerCommand('admin', handleAdmin, { minUserType: 'ADMIN', tickCost: 0, group: 'admin', description: "Admin commands (type 'admin help')" });
  registerCommand('root',  handleRoot,  { minUserType: 'ROOT',  tickCost: 0, group: 'root',  description: "Root access commands" });

  registerPanelRoute('admin_avatar_edit', handleAdminAvatarEditSubmit);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function err(msg)  { return { output: renderOutput(`[color=red]${esc(msg)}[/]`) }; }
function ok(msg)   { return { output: renderOutput(msg) }; }

async function findUser(usernameArg) {
  const name = usernameArg?.replace(/^@/, '');
  if (!name) return null;
  return db.user.findUnique({ where: { username: name } });
}

async function findAvatar(nameArg) {
  const name = nameArg?.replace(/^@/, '');
  if (!name) return null;
  return db.avatar.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
}

async function getHotAvatar(id) {
  const raw = await redis.get(`avatar:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveHotAvatar(id, av) {
  await redis.set(`avatar:${id}`, JSON.stringify(av));
  await markDirty('avatar', id);
}

// ─── admin dispatcher ─────────────────────────────────────────────────────────

async function handleAdmin(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const noun = parts[1]?.toLowerCase();
  const verb = parts[2]?.toLowerCase();

  if (noun === 'user')   return _adminUser(ctx, verb, parts.slice(3));
  if (noun === 'avatar') return _adminAvatar(ctx, verb, parts.slice(3));

  return ok(
    '[b]admin user[/] list | info @user | set-type @user {type} | lock @user | unlock @user\n' +
    '[b]admin avatar[/] list [@user] | info @avatar | edit @avatar |\n' +
    '               set-stat @av {stat} {n} |\n' +
    '               set-wounds @av {n} | set-sanity @av {n} | set-stress @av {n} |\n' +
    '               set-hunger @av {n} | set-rest @av {n} |\n' +
    '               teleport @av {regionId}:{locationId} |\n' +
    '               grant-skill @av {skillId} | revoke-skill @av {skillId} |\n' +
    '               reset-stats @av'
  );
}

// ─── admin user subcommands ───────────────────────────────────────────────────

async function _adminUser(ctx, verb, args) {
  switch (verb) {
    case 'list':      return _userList(ctx);
    case 'info':      return _userInfo(ctx, args[0]);
    case 'set-type':  return _userSetType(ctx, args[0], args[1]);
    case 'lock':      return _userLock(ctx, args[0], true);
    case 'unlock':    return _userLock(ctx, args[0], false);
    default:
      return ok('[b]admin user[/] list | info @user | set-type @user {type} | lock @user | unlock @user');
  }
}

async function _userList(ctx) {
  const users = await db.user.findMany({
    orderBy: { id: 'asc' },
    include: { _count: { select: { avatars: true } } },
  });
  if (!users.length) return ok('[dim]No users.[/]');
  const rows = users.map(u => {
    const locked = u.metadata?.locked ? ' [color=red][locked][/]' : '';
    return `${String(u.id).padStart(4)} ${u.username.padEnd(20)} ${u.type.padEnd(12)} ${u._count.avatars} avatar(s)${locked}`;
  });
  return ok('[b]Users:[/]\n' + rows.join('\n'));
}

async function _userInfo(ctx, usernameArg) {
  const user = await findUser(usernameArg);
  if (!user) return err(`User not found: ${usernameArg ?? '(none)'}`);
  const avatars = await db.avatar.findMany({ where: { userId: user.id }, select: { id: true, name: true, isActive: true } });
  const locked = user.metadata?.locked ? '[color=red] LOCKED[/]' : '';
  const lines = [
    `[b]User ${esc(user.username)}[/]${locked}`,
    `  id: ${user.id}  type: ${user.type}`,
    `  created: ${user.createdAt?.toISOString() ?? 'unknown'}`,
    `  avatars: ${avatars.map(a => `${a.name}(${a.id})`).join(', ') || 'none'}`,
    `  inboxLimit: ${user.inboxLimit ?? 100}`,
  ];
  return ok(lines.join('\n'));
}

async function _userSetType(ctx, usernameArg, typeName) {
  const user = await findUser(usernameArg);
  if (!user) return err(`User not found: ${usernameArg ?? '(none)'}`);

  const newType = typeName?.toUpperCase();
  if (!VALID_USER_TYPES.includes(newType)) {
    return err(`Invalid type. Choose: ${VALID_USER_TYPES.join(', ')}`);
  }

  // ADMIN guardrail: cannot set type higher than POWER_USER
  if (ctx.userType !== 'ROOT' && TYPE_RANK[newType] > TYPE_RANK[ADMIN_MAX_SET_TYPE]) {
    return err(`ADMINs cannot set user type to ${newType}. Only ROOT can.`);
  }

  // Cannot demote/escalate a user whose type is already above actor's rank
  if (ctx.userType !== 'ROOT' && TYPE_RANK[user.type] >= TYPE_RANK[ctx.userType]) {
    return err(`Cannot modify a ${user.type} account as ADMIN.`);
  }

  await db.user.update({ where: { id: user.id }, data: { type: newType } });
  logger.audit('ADMIN', 'user_set_type', {
    actorUserId: ctx.userId,
    targetUserId: user.id,
    targetUsername: user.username,
    oldType: user.type,
    newType,
  });
  return ok(`[color=green]Set ${esc(user.username)} type → ${newType}[/]`);
}

async function _userLock(ctx, usernameArg, lock) {
  const user = await findUser(usernameArg);
  if (!user) return err(`User not found: ${usernameArg ?? '(none)'}`);

  if (ctx.userType !== 'ROOT' && TYPE_RANK[user.type] >= TYPE_RANK[ctx.userType]) {
    return err(`Cannot lock/unlock a ${user.type} account as ADMIN.`);
  }

  const meta = typeof user.metadata === 'object' && user.metadata !== null ? user.metadata : {};
  await db.user.update({ where: { id: user.id }, data: { metadata: { ...meta, locked: lock } } });
  logger.audit('ADMIN', lock ? 'user_lock' : 'user_unlock', { actorUserId: ctx.userId, targetUserId: user.id });
  return ok(`[color=${lock ? 'yellow' : 'green'}]Account ${esc(user.username)} ${lock ? 'locked' : 'unlocked'}.[/]`);
}

// ─── admin avatar subcommands ─────────────────────────────────────────────────

async function _adminAvatar(ctx, verb, args) {
  switch (verb) {
    case 'list':         return _avatarList(ctx, args[0]);
    case 'info':         return _avatarInfo(ctx, args[0]);
    case 'edit':         return _avatarEdit(ctx, args[0]);
    case 'set-stat':     return _avatarSetStat(ctx, args[0], args[1], args[2]);
    case 'set-wounds':   return _avatarSetTrack(ctx, args[0], 'wounds',  args[1]);
    case 'set-sanity':   return _avatarSetTrack(ctx, args[0], 'sanity',  args[1]);
    case 'set-stress':   return _avatarSetTrack(ctx, args[0], 'stress',  args[1]);
    case 'set-hunger':   return _avatarSetTrack(ctx, args[0], 'hunger',  args[1]);
    case 'set-rest':     return _avatarSetTrack(ctx, args[0], 'rest',    args[1]);
    case 'teleport':     return _avatarTeleport(ctx, args[0], args[1]);
    case 'grant-skill':  return _avatarGrantSkill(ctx, args[0], args[1]);
    case 'revoke-skill': return _avatarRevokeSkill(ctx, args[0], args[1]);
    case 'reset-stats':  return _avatarResetStats(ctx, args[0]);
    default:
      return ok(
        '[b]admin avatar[/] list [@user] | info @av | edit @av |\n' +
        '  set-stat @av {key} {n} |\n' +
        '  set-wounds|set-sanity|set-stress|set-hunger|set-rest @av {n} |\n' +
        '  teleport @av {regionId}:{locationId} |\n' +
        '  grant-skill @av {skillId} | revoke-skill @av {skillId} | reset-stats @av'
      );
  }
}

async function _avatarEdit(ctx, nameArg) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);

  const hot = await getHotAvatar(avatar.id);
  const av = hot ?? avatar;
  const stats = av.stats ?? {};

  // Store target in session for submit handler
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingAdminAvatarEdit = avatar.id;
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'admin_avatar_edit',
      descriptor: {
        title: `Edit Avatar — ${esc(avatar.name)}`,
        description: `userId: ${avatar.userId}  |  avatarId: ${avatar.id}`,
        fields: [
          { key: 'phy_for', type: 'number', label: 'PHY FOR', min: 0, max: 99, default: stats.phy_for?.value ?? 20 },
          { key: 'phy_pre', type: 'number', label: 'PHY PRE', min: 0, max: 99, default: stats.phy_pre?.value ?? 20 },
          { key: 'phy_res', type: 'number', label: 'PHY RES', min: 0, max: 99, default: stats.phy_res?.value ?? 20 },
          { key: 'men_for', type: 'number', label: 'MEN FOR', min: 0, max: 99, default: stats.men_for?.value ?? 20 },
          { key: 'men_pre', type: 'number', label: 'MEN PRE', min: 0, max: 99, default: stats.men_pre?.value ?? 20 },
          { key: 'men_res', type: 'number', label: 'MEN RES', min: 0, max: 99, default: stats.men_res?.value ?? 20 },
          { key: 'soc_for', type: 'number', label: 'SOC FOR', min: 0, max: 99, default: stats.soc_for?.value ?? 20 },
          { key: 'soc_pre', type: 'number', label: 'SOC PRE', min: 0, max: 99, default: stats.soc_pre?.value ?? 20 },
          { key: 'soc_res', type: 'number', label: 'SOC RES', min: 0, max: 99, default: stats.soc_res?.value ?? 20 },
          { key: 'wounds', type: 'number', label: 'Wounds', min: 0, max: 20, default: av.wounds ?? 0 },
          { key: 'sanity', type: 'number', label: 'Sanity', min: 0, max: 20, default: av.sanity ?? 0 },
          { key: 'stress', type: 'number', label: 'Stress', min: 0, max: 20, default: av.stress ?? 1 },
          { key: 'hunger', type: 'number', label: 'Hunger', min: 0, max: 100, default: av.hunger ?? 0 },
          { key: 'rest',   type: 'number', label: 'Rest',   min: 0, max: 100, default: av.rest   ?? 100 },
        ],
      },
    },
  };
}

async function handleAdminAvatarEditSubmit(ctx, payload) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const avatarId = session.pendingAdminAvatarEdit;
  delete session.pendingAdminAvatarEdit;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  if (!avatarId) return { output: renderOutput('[color=red]No avatar edit target in session.[/]') };

  const hot = await getHotAvatar(avatarId);
  if (!hot) return { output: renderOutput('[color=red]Avatar not in hot-state.[/]') };

  const changedFields = [];

  // Apply stat changes
  const newStats = { ...(hot.stats ?? {}) };
  for (const key of STAT_KEYS) {
    if (payload[key] != null) {
      const newVal = parseInt(payload[key]);
      if (!isNaN(newVal) && newVal !== (hot.stats?.[key]?.value ?? 20)) {
        newStats[key] = { value: newVal, metadata: hot.stats?.[key]?.metadata ?? {} };
        changedFields.push(`${key}=${newVal}`);
      }
    }
  }
  hot.stats = newStats;

  // Apply survival track changes
  for (const track of ['wounds', 'sanity', 'stress', 'hunger', 'rest']) {
    if (payload[track] != null) {
      const newVal = parseInt(payload[track]);
      if (!isNaN(newVal) && newVal !== hot[track]) {
        hot[track] = newVal;
        changedFields.push(`${track}=${newVal}`);
      }
    }
  }

  await saveHotAvatar(avatarId, hot);

  if (changedFields.length > 0) {
    logger.audit('ADMIN', 'avatar_edit_panel', {
      actorUserId: ctx.userId,
      avatarId,
      changes: changedFields.join(', '),
    });
  }

  return { output: renderOutput(`[color=green]Avatar ${avatarId} updated: ${changedFields.join(', ') || '(no changes)'}[/]`) };
}

async function _avatarList(ctx, usernameArg) {
  let avatars;
  if (usernameArg) {
    const user = await findUser(usernameArg);
    if (!user) return err(`User not found: ${usernameArg}`);
    avatars = await db.avatar.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
  } else {
    avatars = await db.avatar.findMany({ orderBy: { id: 'asc' }, take: 100 });
  }
  if (!avatars.length) return ok('[dim]No avatars found.[/]');
  const rows = avatars.map(a => `${String(a.id).padStart(6)} ${a.name.padEnd(24)} userId:${a.userId} region:${a.regionId ?? 'void'}`);
  return ok('[b]Avatars:[/]\n' + rows.join('\n'));
}

async function _avatarInfo(ctx, nameArg) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);

  const hot = await getHotAvatar(avatar.id);
  const av = hot ?? avatar;

  const stats = STAT_KEYS.map(k => `${k}:${av.stats?.[k]?.value ?? 20}`).join('  ');
  const skills = Object.entries(av.skills ?? {})
    .filter(([, v]) => v?.acquired)
    .map(([id]) => id)
    .join(', ') || 'none';
  const conds = (av.activeConditions ?? []).map(c => c.name).join(', ') || 'none';
  const lines = [
    `[b]Avatar ${esc(av.name)}[/] (id:${avatar.id} userId:${avatar.userId})`,
    `  Location: region:${av.regionId ?? 'void'} loc:${av.locationId ?? 'void'}`,
    `  Stats:    ${stats}`,
    `  Wounds:   ${av.wounds}/${av.woundMax ?? 3}  Sanity:${av.sanity}/${av.sanityMax ?? 3}  Stress:${av.stress}  Hunger:${av.hunger}  Rest:${av.rest}`,
    `  Skills:   ${skills}`,
    `  Conds:    ${conds}`,
    hot ? '[dim](hot-state)[/]' : '[dim](DB snapshot)[/]',
  ];
  return ok(lines.join('\n'));
}

async function _avatarSetStat(ctx, nameArg, statKey, valueStr) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);
  if (!STAT_KEYS.includes(statKey)) return err(`Invalid stat key. Valid: ${STAT_KEYS.join(', ')}`);
  const value = parseInt(valueStr);
  if (isNaN(value) || value < 0 || value > 40) return err('Value must be an integer 0–40.');

  const hot = await getHotAvatar(avatar.id);
  const av = hot ?? { ...avatar, stats: avatar.stats ?? {} };
  av.stats = av.stats ?? {};
  av.stats[statKey] = { value, metadata: av.stats[statKey]?.metadata ?? {} };

  if (hot) {
    await saveHotAvatar(avatar.id, av);
  } else {
    await db.avatar.update({ where: { id: avatar.id }, data: { stats: av.stats } });
  }
  logger.audit('ADMIN', 'avatar_set_stat', { actorUserId: ctx.userId, avatarId: avatar.id, statKey, value });
  return ok(`[color=green]Set ${esc(nameArg)} ${statKey} → ${value}[/]`);
}

async function _avatarSetTrack(ctx, nameArg, track, valueStr) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);
  const value = parseInt(valueStr);
  if (isNaN(value)) return err(`Value must be an integer.`);

  // Clamp to track-appropriate range
  const maxMap = { wounds: avatar.woundMax ?? 3, sanity: avatar.sanityMax ?? 3, stress: 20, hunger: 100, rest: 100 };
  const clamped = Math.max(0, Math.min(value, maxMap[track] ?? 100));

  const hot = await getHotAvatar(avatar.id);
  const av = hot ?? avatar;
  av[track] = clamped;

  if (hot) {
    await saveHotAvatar(avatar.id, av);
  } else {
    await db.avatar.update({ where: { id: avatar.id }, data: { [track]: clamped } });
  }
  logger.audit('ADMIN', `avatar_set_${track}`, { actorUserId: ctx.userId, avatarId: avatar.id, value: clamped });
  return ok(`[color=green]Set ${esc(nameArg)} ${track} → ${clamped}[/]`);
}

async function _avatarTeleport(ctx, nameArg, locationArg) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);

  const stripped = locationArg?.replace(/^#/, '') ?? '';
  const parts = stripped.split(':');
  const regionId = parseInt(parts[0]);
  const locationId = parseInt(parts[1]);
  if (isNaN(regionId) || isNaN(locationId)) {
    return err('Location format: {regionId}:{locationId} (e.g. 1:5 or #1:5)');
  }

  const loc = await db.location.findUnique({ where: { regionId_id: { regionId, id: locationId } } });
  if (!loc) return err(`Location ${regionId}:${locationId} not found.`);

  const hot = await getHotAvatar(avatar.id);
  if (hot) {
    hot.regionId = regionId;
    hot.locationId = locationId;
    await saveHotAvatar(avatar.id, hot);
  } else {
    await db.avatar.update({ where: { id: avatar.id }, data: { regionId, locationId } });
  }
  logger.audit('ADMIN', 'avatar_teleport', { actorUserId: ctx.userId, avatarId: avatar.id, regionId, locationId });
  return ok(`[color=green]Teleported ${esc(nameArg)} → region ${regionId} loc ${locationId} (${esc(loc.name)})[/]`);
}

async function _avatarGrantSkill(ctx, nameArg, skillIdStr) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);
  const skillId = parseInt(skillIdStr);
  if (isNaN(skillId)) return err('Skill ID must be an integer.');

  const result = await grantSkill('avatar', avatar.id, skillId, {});
  if (!result.ok) return err(result.reason);
  logger.audit('ADMIN', 'avatar_grant_skill', { actorUserId: ctx.userId, avatarId: avatar.id, skillId });
  return ok(`[color=green]Granted skill ${skillId} to ${esc(nameArg)}.[/]`);
}

async function _avatarRevokeSkill(ctx, nameArg, skillIdStr) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);
  const skillId = parseInt(skillIdStr);
  if (isNaN(skillId)) return err('Skill ID must be an integer.');

  const result = await revokeSkill('avatar', avatar.id, skillId);
  if (!result.ok) return err(result.reason);
  logger.audit('ADMIN', 'avatar_revoke_skill', { actorUserId: ctx.userId, avatarId: avatar.id, skillId });
  return ok(`[color=yellow]Revoked skill ${skillId} from ${esc(nameArg)}.[/]`);
}

async function _avatarResetStats(ctx, nameArg) {
  const avatar = await findAvatar(nameArg);
  if (!avatar) return err(`Avatar not found: ${nameArg ?? '(none)'}`);

  const baseline = defaultStats();
  const hot = await getHotAvatar(avatar.id);
  if (hot) {
    hot.stats = baseline;
    await saveHotAvatar(avatar.id, hot);
  } else {
    await db.avatar.update({ where: { id: avatar.id }, data: { stats: baseline } });
  }
  logger.audit('ADMIN', 'avatar_reset_stats', { actorUserId: ctx.userId, avatarId: avatar.id });
  return ok(`[color=yellow]Reset all stats for ${esc(nameArg)} to baseline 20.[/]`);
}

// ─── root dispatcher ──────────────────────────────────────────────────────────

async function handleRoot(ctx) {
  if (ctx.userType !== 'ROOT') return err('ROOT access only.');

  const parts = ctx.raw.trim().split(/\s+/);
  const noun = parts[1]?.toLowerCase();

  if (noun === 'set-user')  return _rootSetUser(ctx, parts.slice(2));
  if (noun === 'set-world') return _rootSetWorld(ctx, parts.slice(2));

  return ok(
    '[b]root set-user[/] @username {field} {value}\n' +
    '[b]root set-world[/] {key} {value}\n' +
    'Fields: type, inboxLimit'
  );
}

const ROOT_USER_FIELDS = new Set(['type', 'inboxLimit']);

async function _rootSetUser(ctx, args) {
  const user = await findUser(args[0]);
  if (!user) return err(`User not found: ${args[0] ?? '(none)'}`);

  const field = args[1];
  if (!field || !ROOT_USER_FIELDS.has(field)) {
    return err(`Unknown field. Valid: ${[...ROOT_USER_FIELDS].join(', ')}`);
  }

  let value = args[2];
  if (value === undefined) return err('Provide a value.');

  if (field === 'type') {
    const t = value.toUpperCase();
    if (!VALID_USER_TYPES.includes(t)) return err(`Invalid type: ${value}`);
    value = t;
  } else if (field === 'inboxLimit') {
    value = parseInt(value);
    if (isNaN(value) || value < 0) return err('inboxLimit must be a non-negative integer.');
  }

  await db.user.update({ where: { id: user.id }, data: { [field]: value } });
  logger.audit('ROOT', 'root_set_user', { actorUserId: ctx.userId, targetUserId: user.id, field, value });
  return ok(`[color=green]Set ${esc(user.username)}.${field} → ${esc(String(value))}[/]`);
}

async function _rootSetWorld(ctx, args) {
  const key = args[0];
  if (!key) return err('Usage: root set-world {key} {value}');
  const rawValue = args.slice(1).join(' ');
  if (!rawValue) return err('Provide a value.');

  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue; // treat as string if not valid JSON
  }

  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const cfg = typeof world?.config === 'object' && world.config !== null ? { ...world.config } : {};
  cfg[key] = value;
  await db.worldState.update({ where: { id: 1 }, data: { config: cfg } });
  logger.audit('ROOT', 'root_set_world', { actorUserId: ctx.userId, key, value });
  return ok(`[color=green]WorldState.config.${esc(key)} → ${esc(JSON.stringify(value))}[/]`);
}
