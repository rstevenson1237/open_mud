// Builder commands: world-structure editing, scripting, skill grants, region config.
// All require POWER_USER or above; checkPermission enforces region scope.
import { registerCommand } from './commands.js';
import { registerPanelRoute } from './panels.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { checkPermission } from '../engine/permissions.js';
import { parseDSL } from '../engine/dsl/parser.js';
import { logger } from '../log/logger.js';

export function register() {
  registerCommand('create',       handleCreate,      { minUserType: 'POWER_USER' });
  registerCommand('describe',     handleDescribe,    { minUserType: 'POWER_USER' });
  registerCommand('rename',       handleRename,      { minUserType: 'POWER_USER' });
  registerCommand('zone',         handleZone,        { minUserType: 'POWER_USER' });
  registerCommand('lock',         handleLock,        { minUserType: 'POWER_USER' });
  registerCommand('unlock',       handleUnlock,      { minUserType: 'POWER_USER' });
  registerCommand('hide',         handleHide,        { minUserType: 'POWER_USER' });
  registerCommand('show',         handleShow,        { minUserType: 'POWER_USER' });
  registerCommand('link',         handleLink,        { minUserType: 'POWER_USER' });
  registerCommand('place',        handlePlace,       { minUserType: 'POWER_USER' });
  registerCommand('set',          handleSet,         { minUserType: 'POWER_USER' });
  registerCommand('script',       handleScript,      { minUserType: 'POWER_USER' });
  registerCommand('edit',         handleEdit,        { minUserType: 'POWER_USER' });
  registerCommand('view-script',  handleViewScript,  { minUserType: 'POWER_USER' });
  registerCommand('clear-script', handleClearScript, { minUserType: 'POWER_USER' });
  registerCommand('grant',        handleGrant,       { minUserType: 'POWER_USER' });
  registerCommand('revoke',       handleRevoke,      { minUserType: 'POWER_USER' });
  registerCommand('config',       handleConfig,      { minUserType: 'POWER_USER' });

  registerPanelRoute('script_edit',      handleScriptEditSubmit);
  registerPanelRoute('create_location',  handleCreateLocationSubmit);
  registerPanelRoute('create_template',  handleCreateTemplateSubmit);
  registerPanelRoute('create_exit',      handleCreateExitSubmit);
  registerPanelRoute('describe_target',  handleDescribeTargetSubmit);
  registerPanelRoute('region_config',    handleRegionConfigSubmit);
}

// ─── Permission helper ────────────────────────────────────────────────────────

async function perm(ctx, action, target) {
  const res = await checkPermission(
    { userId: ctx.userId, userType: ctx.userType, avatarId: ctx.avatarId },
    action, target,
  );
  return res;
}

// ─── Target resolution helpers ────────────────────────────────────────────────

async function resolveLocation(arg, regionId) {
  if (!arg || arg === 'here') return null; // use current location
  const stripped = arg.replace(/^#/, '');
  const byId = parseInt(stripped);
  if (!isNaN(byId)) {
    return db.location.findUnique({ where: { regionId_id: { regionId, id: byId } } });
  }
  return db.location.findFirst({ where: { regionId, name: { equals: stripped, mode: 'insensitive' } } });
}

async function resolveExit(dir, regionId, locationId) {
  return db.exit.findFirst({ where: { regionId, fromLocationId: locationId, direction: dir.toLowerCase() } });
}

async function nextLocationId(regionId) {
  const row = await db.location.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
  return (row?.id ?? 0) + 1;
}

async function nextExitId(regionId) {
  const row = await db.exit.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
  return (row?.id ?? 0) + 1;
}

async function nextTemplateId() {
  const row = await db.objectTemplate.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  return (row?.id ?? 0) + 1;
}

async function nextInstanceId(regionId) {
  const row = await db.objectInstance.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
  return (row?.id ?? 0) + 1;
}

// ─── Script helpers ───────────────────────────────────────────────────────────

async function getOrCreateScript(attachType, attachId, body = { rules: [], subroutines: {} }) {
  let script = await db.script.findFirst({
    where: { attachedToType: attachType, attachedToId: String(attachId) },
  });
  if (!script) {
    script = await db.script.create({
      data: { attachedToType: attachType, attachedToId: String(attachId), body },
    });
  }
  return script;
}

async function attachScriptToLocation(regionId, locationId, scriptId) {
  await db.location.update({
    where: { regionId_id: { regionId, id: locationId } },
    data: { scriptId },
  });
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

async function handleCreate(ctx) {
  if (!ctx.regionId) return { output: renderOutput('[color=red]No active region.[/]') };
  const parts = ctx.raw.trim().split(/\s+/);
  const subCmd = parts[1]?.toLowerCase();

  if (subCmd === 'location') {
    return handleCreateLocation(ctx, parts.slice(2).join(' '));
  }
  if (subCmd === 'exit') {
    return handleCreateExit(ctx, parts.slice(2));
  }
  if (subCmd === 'region') {
    return handleCreateRegion(ctx, parts.slice(2).join(' '));
  }
  if (subCmd === 'template') {
    return handleCreateTemplate(ctx, parts.slice(2));
  }
  if (subCmd === 'instance') {
    return handleCreateInstance(ctx, parts.slice(2));
  }
  return { output: renderOutput('[b]Usage:[/] create location|exit|region|template|instance ...') };
}

async function handleCreateLocation(ctx, name) {
  if (!name) {
    return {
      panel: {
        handlerKey: 'create_location',
        descriptor: {
          title: 'Create Location',
          fields: [
            { key: 'name',        type: 'text',     label: 'Location Name', minLength: 1, maxLength: 60 },
            {
              key: 'zoneType',    type: 'select',   label: 'Zone Type',
              options: [
                { value: 'SAFE',      label: 'Safe'      },
                { value: 'OPEN',      label: 'Open'      },
                { value: 'DANGEROUS', label: 'Dangerous' },
              ],
              default: 'SAFE',
            },
            { key: 'description', type: 'textarea', label: 'Description', rows: 4, required: false, placeholder: 'You stand in...' },
          ],
        },
      },
    };
  }

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextLocationId(ctx.regionId);
  await db.location.create({
    data: { regionId: ctx.regionId, id: newId, name, description: '', metadata: {} },
  });

  logger.audit('BUILDER', 'create_location', { userId: ctx.userId, regionId: ctx.regionId, locationId: newId, name });
  return { output: renderOutput(`[color=green]Location created:[/] [b]${esc(name)}[/] (id ${newId} in region ${ctx.regionId})`) };
}

async function handleCreateLocationSubmit(ctx, payload) {
  if (!ctx.regionId) return { output: renderOutput('[color=red]No active region.[/]') };
  const { name, zoneType, description } = payload;
  if (!name?.trim()) return { output: renderOutput('[color=red]Name is required.[/]') };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextLocationId(ctx.regionId);
  await db.location.create({
    data: {
      regionId: ctx.regionId, id: newId,
      name: name.trim(),
      zoneType: zoneType ?? 'SAFE',
      description: description ?? '',
      metadata: {},
    },
  });

  logger.audit('BUILDER', 'create_location', { userId: ctx.userId, regionId: ctx.regionId, locationId: newId, name });
  return { output: renderOutput(`[color=green]Location created:[/] [b]${esc(name)}[/] (id ${newId} in region ${ctx.regionId})`) };
}

const VALID_DIRS = ['north','south','east','west','northeast','northwest','southeast','southwest','up','down','in','out'];

async function handleCreateExit(ctx, parts) {
  // create exit {dir} to #{locId}
  const toIdx = parts.indexOf('to');
  if (toIdx < 1) {
    // Open panel
    return {
      panel: {
        handlerKey: 'create_exit',
        descriptor: {
          title: 'Create Exit',
          fields: [
            {
              key: 'direction', type: 'select', label: 'Direction',
              options: VALID_DIRS.map(d => ({ value: d, label: d })),
            },
            { key: 'toLocationId', type: 'number', label: 'Destination Location #ID', min: 0 },
            {
              key: 'toRegionId', type: 'number', label: 'Destination Region ID (blank = current)',
              required: false, default: ctx.regionId,
            },
            { key: 'hidden', type: 'checkbox', label: 'Hidden', default: false },
          ],
        },
      },
    };
  }

  const dir = parts.slice(0, toIdx).join(' ').toLowerCase();
  const toArg = parts.slice(toIdx + 1).join(' ');
  const toLoc = await resolveLocation(toArg, ctx.regionId);
  if (!toLoc) return { output: renderOutput(`[color=red]Location '${esc(toArg)}' not found.[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextExitId(ctx.regionId);
  await db.exit.create({
    data: {
      id: newId, regionId: ctx.regionId,
      fromLocationId: ctx.locationId, direction: dir,
      toRegionId: ctx.regionId, toLocationId: toLoc.id,
      isState: {},
    },
  });

  logger.audit('BUILDER', 'create_exit', { userId: ctx.userId, regionId: ctx.regionId, exitId: newId, dir, toLoc: toLoc.id });
  return { output: renderOutput(`[color=green]Exit created:[/] '${esc(dir)}' → location ${toLoc.id} (exit id ${newId})`) };
}

async function handleCreateExitSubmit(ctx, payload) {
  if (!ctx.regionId) return { output: renderOutput('[color=red]No active region.[/]') };
  const { direction, toLocationId, toRegionId, hidden } = payload;
  if (!direction) return { output: renderOutput('[color=red]Direction is required.[/]') };
  const destRegionId = toRegionId ?? ctx.regionId;
  const destLocId = parseInt(toLocationId);
  if (isNaN(destLocId)) return { output: renderOutput('[color=red]Destination location ID is required.[/]') };

  const toLoc = await db.location.findUnique({ where: { regionId_id: { regionId: destRegionId, id: destLocId } } });
  if (!toLoc) return { output: renderOutput(`[color=red]Location ${destRegionId}:${destLocId} not found.[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextExitId(ctx.regionId);
  await db.exit.create({
    data: {
      id: newId, regionId: ctx.regionId,
      fromLocationId: ctx.locationId, direction,
      toRegionId: destRegionId, toLocationId: destLocId,
      isState: hidden ? { hidden: true } : {},
    },
  });

  logger.audit('BUILDER', 'create_exit', { userId: ctx.userId, regionId: ctx.regionId, exitId: newId, direction, destLocId });
  return { output: renderOutput(`[color=green]Exit created:[/] '${esc(direction)}' → location ${destLocId} (exit id ${newId})`) };
}

async function handleCreateRegion(ctx, name) {
  if (ctx.userType !== 'ROOT' && ctx.userType !== 'ADMIN') {
    return { output: renderOutput('[color=red]Only ADMIN or ROOT may create regions.[/]') };
  }
  if (!name) return { output: renderOutput('[b]Usage:[/] create region {name}') };

  const region = await db.region.create({
    data: { name, config: { toggles: {}, defaultZoneType: 'SAFE' }, metadata: {} },
  });

  logger.audit('BUILDER', 'create_region', { userId: ctx.userId, regionId: region.id, name });
  return { output: renderOutput(`[color=green]Region created:[/] [b]${esc(name)}[/] (id ${region.id})`) };
}

const TEMPLATE_TYPES = ['GENERIC','CONTAINER','WEAPON','ARMOR','COIN','VENDOR','MOB','EXTENDED'];

async function handleCreateTemplate(ctx, parts) {
  // create template {name} {type} — inline bypass when both provided
  if (parts.length >= 2) {
    const type = parts[parts.length - 1].toUpperCase();
    const name = parts.slice(0, -1).join(' ');
    const validTypes = ['ITEM', 'MOB', 'ARMOR', 'WEAPON', 'FOOD', 'DRINK', 'COIN', 'CONTAINER', 'EXTENDED', ...TEMPLATE_TYPES];
    if (validTypes.includes(type) && name) {
      const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
      if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };
      const newId = await nextTemplateId();
      await db.objectTemplate.create({
        data: { id: newId, name, type, regionId: ctx.regionId, baseSchema: {}, aliases: [], metadata: {} },
      });
      logger.audit('BUILDER', 'create_template', { userId: ctx.userId, templateId: newId, name, type });
      return { output: renderOutput(`[color=green]Template created:[/] [b]${esc(name)}[/] type=${type} (id $${newId})`) };
    }
  }

  // Open panel
  return {
    panel: {
      handlerKey: 'create_template',
      descriptor: {
        title: 'Create Object Template',
        fields: [
          { key: 'name',        type: 'text',     label: 'Template Name', minLength: 1, maxLength: 60 },
          {
            key: 'type',        type: 'select',   label: 'Object Type',
            options: TEMPLATE_TYPES.map(t => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() })),
            default: 'GENERIC',
          },
          { key: 'description', type: 'textarea', label: 'Description', rows: 3, required: false },
          { key: 'weight',      type: 'number',   label: 'Weight (units)', min: 0, default: 1 },
        ],
      },
    },
  };
}

async function handleCreateTemplateSubmit(ctx, payload) {
  if (!ctx.regionId) return { output: renderOutput('[color=red]No active region.[/]') };
  const { name, type, description, weight } = payload;
  if (!name?.trim()) return { output: renderOutput('[color=red]Name is required.[/]') };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextTemplateId();
  await db.objectTemplate.create({
    data: {
      id: newId,
      name: name.trim(),
      type: type ?? 'GENERIC',
      regionId: ctx.regionId,
      baseSchema: {
        description: description ?? '',
        weight: weight ?? 1,
      },
      aliases: [],
      metadata: {},
    },
  });

  logger.audit('BUILDER', 'create_template', { userId: ctx.userId, templateId: newId, name, type });
  return { output: renderOutput(`[color=green]Template created:[/] [b]${esc(name)}[/] type=${type} (id $${newId})`) };
}

async function handleCreateInstance(ctx, parts) {
  // create instance #{tplId} [at #{locId}]
  if (!parts.length) return { output: renderOutput('[b]Usage:[/] create instance #{tplId} [at #{locId}]') };
  const atIdx = parts.indexOf('at');
  const tplArg = parts.slice(0, atIdx > 0 ? atIdx : undefined).join(' ');
  const tplId = parseInt(tplArg.replace(/^[$#]/, ''));
  if (isNaN(tplId)) return { output: renderOutput(`[color=red]Invalid template id: ${esc(tplArg)}[/]`) };

  let locId = ctx.locationId;
  if (atIdx > 0) {
    const locArg = parts.slice(atIdx + 1).join(' ');
    const loc = await resolveLocation(locArg, ctx.regionId);
    if (!loc) return { output: renderOutput(`[color=red]Location '${esc(locArg)}' not found.[/]`) };
    locId = loc.id;
  }

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const newId = await nextInstanceId(ctx.regionId);
  await db.objectInstance.create({
    data: {
      id: newId, regionId: ctx.regionId, templateId: tplId,
      ownerType: 'LOCATION', ownerId: String(locId),
      state: {}, isState: {}, count: 1, metadata: {},
    },
  });

  logger.audit('BUILDER', 'create_instance', { userId: ctx.userId, regionId: ctx.regionId, instanceId: newId, tplId, locId });
  return { output: renderOutput(`[color=green]Instance created:[/] $${newId} (template $${tplId}) at location ${locId}`) };
}

// ─── DESCRIBE / RENAME ────────────────────────────────────────────────────────

async function handleDescribe(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const targetArg = parts[1];
  const text = parts.slice(2).join(' ');
  if (!targetArg) return { output: renderOutput('[b]Usage:[/] describe {#loc|here} [text]') };

  const rId = ctx.regionId;
  let loc;
  if (targetArg === 'here') {
    loc = await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: ctx.locationId } } });
  } else {
    loc = await resolveLocation(targetArg, rId);
  }
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(targetArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  // Inline bypass: text provided on command line
  if (text) {
    await db.location.update({
      where: { regionId_id: { regionId: rId, id: loc.id } },
      data: { description: text },
    });
    logger.audit('BUILDER', 'describe_location', { userId: ctx.userId, regionId: rId, locationId: loc.id });
    return { output: renderOutput(`[color=green]Description updated for location ${loc.id}.[/]`) };
  }

  // Store target reference in session for submit handler
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingDescribeTarget = { type: 'LOCATION', regionId: rId, id: loc.id };
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'describe_target',
      descriptor: {
        title: `Describe — ${esc(loc.name)}`,
        fields: [
          {
            key: 'description',
            type: 'textarea',
            label: 'Description',
            rows: 6,
            default: loc.description ?? '',
            placeholder: 'You stand in a dimly lit room...',
          },
        ],
      },
    },
  };
}

async function handleDescribeTargetSubmit(ctx, payload) {
  const { description } = payload;

  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const target = session.pendingDescribeTarget;
  delete session.pendingDescribeTarget;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  if (!target) return { output: renderOutput('[color=red]No describe target in session.[/]') };

  if (target.type === 'LOCATION') {
    await db.location.update({
      where: { regionId_id: { regionId: target.regionId, id: target.id } },
      data: { description: description ?? '' },
    });
    logger.audit('BUILDER', 'describe_location', { userId: ctx.userId, regionId: target.regionId, locationId: target.id });
    return { output: renderOutput(`[color=green]Description updated for location ${target.id}.[/]`) };
  }

  return { output: renderOutput('[color=red]Unknown describe target type.[/]') };
}

async function handleRename(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const targetArg = parts[1];
  const name = parts.slice(2).join(' ');
  if (!targetArg || !name) return { output: renderOutput('[b]Usage:[/] rename {#loc|here} {name}') };

  const rId = ctx.regionId;
  const loc = targetArg === 'here'
    ? { regionId: rId, id: ctx.locationId }
    : await resolveLocation(targetArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(targetArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  await db.location.update({
    where: { regionId_id: { regionId: rId, id: loc.id } },
    data: { name },
  });

  return { output: renderOutput(`[color=green]Location ${loc.id} renamed to: ${esc(name)}[/]`) };
}

// ─── ZONE ────────────────────────────────────────────────────────────────────

async function handleZone(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const locArg = parts[1];
  const zoneArg = parts[2]?.toUpperCase();
  const VALID_ZONES = ['SAFE', 'OPEN', 'DANGEROUS'];
  if (!locArg || !VALID_ZONES.includes(zoneArg)) {
    return { output: renderOutput('[b]Usage:[/] zone {#loc|here} {safe|open|dangerous}') };
  }

  const rId = ctx.regionId;
  const loc = locArg === 'here'
    ? { id: ctx.locationId }
    : await resolveLocation(locArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(locArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  await db.location.update({
    where: { regionId_id: { regionId: rId, id: loc.id } },
    data: { zoneType: zoneArg },
  });

  return { output: renderOutput(`[color=green]Location ${loc.id} zone set to ${zoneArg}.[/]`) };
}

// ─── LOCK / UNLOCK / HIDE / SHOW ─────────────────────────────────────────────

async function handleLock(ctx) { return _setExitIsState(ctx, 'locked', true); }
async function handleUnlock(ctx) { return _setExitIsState(ctx, 'locked', false); }
async function handleHide(ctx)   { return _setExitIsState(ctx, 'hidden', true); }
async function handleShow(ctx)   { return _setExitIsState(ctx, 'hidden', false); }

async function _setExitIsState(ctx, key, value) {
  const parts = ctx.raw.trim().split(/\s+/);
  const dir = parts[1];
  if (!dir) return { output: renderOutput(`[b]Usage:[/] ${parts[0]} {direction}`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const exit = await resolveExit(dir, ctx.regionId, ctx.locationId);
  if (!exit) return { output: renderOutput(`[color=red]No exit to '${esc(dir)}' from here.[/]`) };

  const isState = { ...(exit.isState ?? {}), [key]: value };
  await db.exit.update({ where: { regionId_id: { regionId: ctx.regionId, id: exit.id } }, data: { isState } });

  const verb = key === 'locked' ? (value ? 'locked' : 'unlocked') : (value ? 'hidden' : 'shown');
  return { output: renderOutput(`[color=green]Exit '${esc(dir)}' ${verb}.[/]`) };
}

// ─── LINK ─────────────────────────────────────────────────────────────────────

async function handleLink(ctx) {
  // link {exitDir} to #{locId}
  const parts = ctx.raw.trim().split(/\s+/);
  const toIdx = parts.indexOf('to');
  if (toIdx < 2) return { output: renderOutput('[b]Usage:[/] link {exitDir} to #{locId}') };
  const dir = parts.slice(1, toIdx).join(' ');
  const locArg = parts.slice(toIdx + 1).join(' ');

  const toLoc = await resolveLocation(locArg, ctx.regionId);
  if (!toLoc) return { output: renderOutput(`[color=red]Location '${esc(locArg)}' not found.[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const exit = await resolveExit(dir, ctx.regionId, ctx.locationId);
  if (!exit) return { output: renderOutput(`[color=red]No exit to '${esc(dir)}' from here.[/]`) };

  await db.exit.update({
    where: { regionId_id: { regionId: ctx.regionId, id: exit.id } },
    data: { toLocationId: toLoc.id, toRegionId: ctx.regionId },
  });

  return { output: renderOutput(`[color=green]Exit '${esc(dir)}' now links to location ${toLoc.id}.[/]`) };
}

// ─── PLACE ────────────────────────────────────────────────────────────────────

async function handlePlace(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const instArg = parts[1];
  if (!instArg) return { output: renderOutput('[b]Usage:[/] place $#{instId}') };
  const instId = parseInt(instArg.replace(/^[$#]/, ''));
  if (isNaN(instId)) return { output: renderOutput('[color=red]Invalid instance id.[/]') };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  await db.objectInstance.update({
    where: { regionId_id: { regionId: ctx.regionId, id: instId } },
    data: { ownerType: 'LOCATION', ownerId: String(ctx.locationId) },
  });

  return { output: renderOutput(`[color=green]Instance $${instId} placed here.[/]`) };
}

// ─── SET ─────────────────────────────────────────────────────────────────────

async function handleSet(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const instArg = parts[1];
  const key = parts[2];
  const val = parts[3];
  if (!instArg || !key || val === undefined) {
    return { output: renderOutput('[b]Usage:[/] set $#{instId} {key} {value}') };
  }
  const instId = parseInt(instArg.replace(/^[$#]/, ''));
  if (isNaN(instId)) return { output: renderOutput('[color=red]Invalid instance id.[/]') };

  const p = await perm(ctx, 'write', { type: 'region', id: String(ctx.regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const inst = await db.objectInstance.findUnique({ where: { regionId_id: { regionId: ctx.regionId, id: instId } } });
  if (!inst) return { output: renderOutput(`[color=red]Instance $${instId} not found.[/]`) };

  const parsed = val === 'true' ? true : val === 'false' ? false : (isNaN(Number(val)) ? val : Number(val));
  const isState = { ...(inst.isState ?? {}), [key]: parsed };
  await db.objectInstance.update({
    where: { regionId_id: { regionId: ctx.regionId, id: instId } },
    data: { isState },
  });

  return { output: renderOutput(`[color=green]$${instId}.isState.${key} = ${JSON.stringify(parsed)}[/]`) };
}

// ─── SCRIPT ──────────────────────────────────────────────────────────────────

async function handleScript(ctx) {
  // script {#loc|here} {dsl_line}
  const raw = ctx.raw.trim();
  const firstSpace = raw.indexOf(' ');
  if (firstSpace < 0) return { output: renderOutput('[b]Usage:[/] script {#loc|here} {dsl_line}') };
  const rest = raw.slice(firstSpace + 1).trimStart();
  const secondSpace = rest.indexOf(' ');
  if (secondSpace < 0) return { output: renderOutput('[b]Usage:[/] script {#loc|here} {dsl_line}') };
  const locArg = rest.slice(0, secondSpace);
  const dslLine = rest.slice(secondSpace + 1).trim();
  if (!dslLine) return { output: renderOutput('[b]Usage:[/] script {#loc|here} {dsl_line}') };

  const rId = ctx.regionId;
  const loc = locArg === 'here'
    ? await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: ctx.locationId } } })
    : await resolveLocation(locArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(locArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  return _appendDSLLine(rId, loc, dslLine);
}

async function _appendDSLLine(rId, loc, dslLine) {
  const parsed = parseDSL(dslLine);
  if (!parsed.ok) {
    return { output: renderOutput(`[color=red]DSL error:[/]\n${parsed.errors.join('\n')}`) };
  }

  const script = await getOrCreateScript('LOCATION', `${rId}:${loc.id}`);
  const body = script.body ?? { rules: [], subroutines: {} };
  const rules = Array.isArray(body) ? body : (body.rules ?? []);
  const subroutines = Array.isArray(body) ? {} : (body.subroutines ?? {});
  const newRules = parsed.body?.rules ?? [];
  const updatedBody = { rules: [...rules, ...newRules], subroutines };

  await db.script.update({ where: { id: script.id }, data: { body: updatedBody } });

  // Attach script to location if not already attached
  const freshLoc = await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: loc.id } } });
  if (!freshLoc?.scriptId || freshLoc.scriptId !== script.id) {
    await attachScriptToLocation(rId, loc.id, script.id);
  }

  logger.audit('BUILDER', 'script_append', { userId: undefined, regionId: rId, locationId: loc.id, scriptId: script.id });
  return { output: renderOutput(`[color=green]Rule appended to location ${loc.id} script (id ${script.id}).[/]`) };
}

// ─── EDIT (panel-based script editor) ────────────────────────────────────────

async function handleEdit(ctx) {
  // edit {#loc|here}
  const parts = ctx.raw.trim().split(/\s+/);
  const locArg = parts[1] ?? 'here';
  const rId = ctx.regionId;

  const loc = locArg === 'here'
    ? await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: ctx.locationId } } })
    : await resolveLocation(locArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(locArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const existing = await db.script.findFirst({
    where: { attachedToType: 'LOCATION', attachedToId: `${rId}:${loc.id}` },
  });
  const existingLines = existing ? _bodyToLines(existing.body) : [];

  // Store edit target in session for submit handler
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingEditTarget = { type: 'LOCATION', attachId: `${rId}:${loc.id}`, regionId: rId, locationId: loc.id };
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'script_edit',
      descriptor: {
        title: `Edit Script — Location ${loc.id}`,
        description: 'Enter DSL rules. Each line: trigger [if condition] do action(args).',
        fields: [
          {
            key: 'body',
            type: 'textarea',
            label: 'Script Body',
            rows: 20,
            default: existingLines.join('\n'),
            placeholder: 'on_enter do say("Welcome.")\non_use if has_item($key) do unlock(#door)',
            required: false,
          },
        ],
      },
    },
  };
}

async function handleScriptEditSubmit(ctx, payload) {
  const { body } = payload;

  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const editTarget = session.pendingEditTarget;
  delete session.pendingEditTarget;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  if (!editTarget) return { output: renderOutput('[color=red]No edit target in session.[/]') };

  if (!body?.trim()) {
    // Empty body — clear the script
    const script = await db.script.findFirst({
      where: { attachedToType: editTarget.type, attachedToId: editTarget.attachId },
    });
    if (script) {
      if (editTarget.type === 'LOCATION') {
        await db.location.update({
          where: { regionId_id: { regionId: editTarget.regionId, id: editTarget.locationId } },
          data: { scriptId: null },
        });
      }
      await db.script.delete({ where: { id: script.id } });
    }
    return { output: renderOutput('[dim]Empty script — cleared.[/]') };
  }

  const parsed = parseDSL(body);
  if (!parsed.ok) {
    const errorMsg = parsed.errors.join('\n');
    return {
      panel: {
        handlerKey: 'script_edit',
        descriptor: {
          title: editTarget.type === 'LOCATION' ? `Edit Script — Location ${editTarget.locationId}` : 'Edit Script',
          description: 'Enter DSL rules. Each line: trigger [if condition] do action(args).',
          error: parsed.errors[0],
          fields: [
            {
              key: 'body',
              type: 'textarea',
              label: 'Script Body',
              rows: 20,
              default: body,
              placeholder: 'on_enter do say("Welcome.")',
              required: false,
            },
          ],
        },
      },
    };
  }

  // Build a minimal session-like object for finalizeEdit
  const editSession = {
    editBuffer: body.split('\n'),
    editTarget,
    sessionToken: ctx.sessionToken,
  };
  const html = await finalizeEdit(editSession);
  return { output: html };
}

function _bodyToLines(body) {
  if (!body) return [];
  const rules = Array.isArray(body) ? body : (body.rules ?? []);
  return rules.map(r => {
    const cond = r.conditions?.length ? ` if ${r.conditions.map(c => `${c.fn}(${c.args.join(',')})`).join(' and ')}` : '';
    const actions = (r.actions ?? []).map(a => `do ${a.fn}(${(a.args ?? []).join(',')})`).join(' ');
    return `${r.trigger}${cond} ${actions}`.trim();
  });
}

// ─── VIEW-SCRIPT ──────────────────────────────────────────────────────────────

async function handleViewScript(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const locArg = parts[1] ?? 'here';
  const rId = ctx.regionId;

  const loc = locArg === 'here'
    ? await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: ctx.locationId } } })
    : await resolveLocation(locArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(locArg)}[/]`) };

  const script = await db.script.findFirst({
    where: { attachedToType: 'LOCATION', attachedToId: `${rId}:${loc.id}` },
  });
  if (!script) return { output: renderOutput(`[dim]No script attached to location ${loc.id}.[/]`) };

  return { output: renderOutput(`[b]Script ${script.id} (location ${loc.id}):[/]\n${JSON.stringify(script.body, null, 2)}`) };
}

// ─── CLEAR-SCRIPT ─────────────────────────────────────────────────────────────

async function handleClearScript(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const locArg = parts[1] ?? 'here';
  const rId = ctx.regionId;

  const loc = locArg === 'here'
    ? await db.location.findUnique({ where: { regionId_id: { regionId: rId, id: ctx.locationId } } })
    : await resolveLocation(locArg, rId);
  if (!loc) return { output: renderOutput(`[color=red]Location not found: ${esc(locArg)}[/]`) };

  const p = await perm(ctx, 'write', { type: 'region', id: String(rId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const script = await db.script.findFirst({
    where: { attachedToType: 'LOCATION', attachedToId: `${rId}:${loc.id}` },
  });
  if (!script) return { output: renderOutput(`[dim]No script to clear on location ${loc.id}.[/]`) };

  await db.location.update({
    where: { regionId_id: { regionId: rId, id: loc.id } },
    data: { scriptId: null },
  });
  await db.script.delete({ where: { id: script.id } });

  return { output: renderOutput(`[color=green]Script cleared from location ${loc.id}.[/]`) };
}

// ─── GRANT / REVOKE skills ────────────────────────────────────────────────────

async function handleGrant(ctx) {
  // grant @{avatarName} {skillId}
  const parts = ctx.raw.trim().split(/\s+/);
  const avArg = parts[1];
  const skillArg = parts[2];
  if (!avArg?.startsWith('@') || !skillArg) {
    return { output: renderOutput('[b]Usage:[/] grant @{avatar} {skillId}') };
  }
  const avName = avArg.slice(1);
  const skillId = parseInt(skillArg);
  if (isNaN(skillId)) return { output: renderOutput('[color=red]Invalid skill id.[/]') };

  const p = await perm(ctx, 'write', { type: 'skill', id: String(skillId) });
  // Fall through for ADMIN/ROOT who always pass
  if (!p.allowed && ctx.userType !== 'ADMIN' && ctx.userType !== 'ROOT') {
    return { output: renderOutput('[color=red]Permission denied.[/]') };
  }

  const avatar = await db.avatar.findFirst({
    where: { name: { equals: avName, mode: 'insensitive' }, isActive: true },
  });
  if (!avatar) return { output: renderOutput(`[color=red]Avatar '${esc(avName)}' not found.[/]`) };

  const def = await db.skillDefinition.findUnique({ where: { id: skillId } }).catch(() => null);
  if (!def) return { output: renderOutput(`[color=red]Skill ${skillId} not found.[/]`) };

  const skills = (avatar.skills ?? {});
  skills[String(skillId)] = { acquired: true, acquiredAt: Date.now() };
  await db.avatar.update({ where: { id: avatar.id }, data: { skills } });

  // Sync to Redis if hot
  const avRaw = await redis.get(`avatar:${avatar.id}`);
  if (avRaw) {
    const av = JSON.parse(avRaw);
    av.skills = skills;
    await redis.set(`avatar:${avatar.id}`, JSON.stringify(av));
  }

  logger.audit('BUILDER', 'grant_skill', { grantorUserId: ctx.userId, avatarId: avatar.id, skillId });
  return { output: renderOutput(`[color=green]Skill ${skillId} granted to ${esc(avName)}.[/]`) };
}

async function handleRevoke(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const avArg = parts[1];
  const skillArg = parts[2];
  if (!avArg?.startsWith('@') || !skillArg) {
    return { output: renderOutput('[b]Usage:[/] revoke @{avatar} {skillId}') };
  }
  const avName = avArg.slice(1);
  const skillId = parseInt(skillArg);
  if (isNaN(skillId)) return { output: renderOutput('[color=red]Invalid skill id.[/]') };

  const avatar = await db.avatar.findFirst({
    where: { name: { equals: avName, mode: 'insensitive' }, isActive: true },
  });
  if (!avatar) return { output: renderOutput(`[color=red]Avatar '${esc(avName)}' not found.[/]`) };

  const skills = { ...(avatar.skills ?? {}) };
  delete skills[String(skillId)];
  await db.avatar.update({ where: { id: avatar.id }, data: { skills } });

  const avRaw = await redis.get(`avatar:${avatar.id}`);
  if (avRaw) {
    const av = JSON.parse(avRaw);
    av.skills = skills;
    await redis.set(`avatar:${avatar.id}`, JSON.stringify(av));
  }

  logger.audit('BUILDER', 'revoke_skill', { revokerUserId: ctx.userId, avatarId: avatar.id, skillId });
  return { output: renderOutput(`[color=green]Skill ${skillId} revoked from ${esc(avName)}.[/]`) };
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

async function handleConfig(ctx) {
  const parts = ctx.raw.trim().split(/\s+/);
  const regionArg = parts[1];
  const key = parts[2];
  const value = parts.slice(3).join(' ');

  let region;
  if (!regionArg || regionArg === 'here') {
    region = ctx.regionId ? await db.region.findUnique({ where: { id: ctx.regionId } }) : null;
  } else {
    const rid = parseInt(regionArg.replace(/^#/, ''));
    region = isNaN(rid) ? null : await db.region.findUnique({ where: { id: rid } });
  }
  if (!region) return { output: renderOutput('[color=red]Region not found.[/]') };

  // Inline single-key set: config #region key value
  if (key && value !== '') {
    const p = await perm(ctx, 'write', { type: 'region', id: String(region.id) });
    if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

    const parsed = value === 'true' ? true : value === 'false' ? false
      : (isNaN(Number(value)) ? value : Number(value));
    const newConfig = { ...(region.config ?? {}), [key]: parsed };
    await db.region.update({ where: { id: region.id }, data: { config: newConfig } });
    return { output: renderOutput(`[color=green]Region ${region.id} config.${key} = ${JSON.stringify(parsed)}[/]`) };
  }

  // No key/value — open config panel
  const cfg = region.config ?? {};
  const toggles = cfg.toggles ?? {};
  const currency = cfg.currency ?? {};

  // Store region id in session for submit handler
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (sessionRaw) {
    const session = JSON.parse(sessionRaw);
    session.pendingConfigRegionId = region.id;
    await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
  }

  return {
    panel: {
      handlerKey: 'region_config',
      descriptor: {
        title: `Region ${region.id} Configuration`,
        description: 'Changes are applied immediately. Toggles take effect next tick.',
        fields: [
          { key: 'woundMax',    type: 'number',  label: 'Wound Max',    min: 1, max: 20, default: cfg.woundMax ?? 3 },
          { key: 'sanityMax',   type: 'number',  label: 'Sanity Max',   min: 1, max: 20, default: cfg.sanityMax ?? 3 },
          {
            key: 'sanityBreakBehavior', type: 'select', label: 'Sanity Break Behavior',
            options: [
              { value: 'condition_only', label: 'Condition Only' },
              { value: 'confusion',      label: 'Confusion'      },
              { value: 'flee',           label: 'Flee'           },
              { value: 'panic',          label: 'Panic'          },
              { value: 'comatose',       label: 'Comatose'       },
              { value: 'mental_break',   label: 'Mental Break'   },
            ],
            default: cfg.sanityBreakBehavior ?? 'condition_only',
          },
          { key: 'dayNightCycleTicks', type: 'number', label: 'Day/Night Cycle (ticks)', min: 0, default: cfg.dayNightCycleTicks ?? 0 },
          { key: 'toggle_combat',   type: 'checkbox', label: 'Combat Enabled',   default: toggles.combat  ?? true  },
          { key: 'toggle_pvp',      type: 'checkbox', label: 'PvP Enabled',      default: toggles.pvp     ?? false },
          { key: 'toggle_hunger',   type: 'checkbox', label: 'Hunger Enabled',   default: toggles.hunger  ?? true  },
          { key: 'toggle_rest',     type: 'checkbox', label: 'Rest Enabled',     default: toggles.rest    ?? true  },
          { key: 'toggle_crafting', type: 'checkbox', label: 'Crafting Enabled', default: toggles.crafting ?? false },
          { key: 'coinWeightDivisor', type: 'number', label: 'Coin Weight Divisor', min: 1, default: currency.coinWeightDivisor ?? 10 },
        ],
      },
    },
  };
}

async function handleRegionConfigSubmit(ctx, payload) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const regionId = session.pendingConfigRegionId;
  delete session.pendingConfigRegionId;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  if (!regionId) return { output: renderOutput('[color=red]No config target in session.[/]') };

  const region = await db.region.findUnique({ where: { id: regionId } });
  if (!region) return { output: renderOutput('[color=red]Region not found.[/]') };

  const p = await perm(ctx, 'write', { type: 'region', id: String(regionId) });
  if (!p.allowed) return { output: renderOutput('[color=red]Permission denied.[/]') };

  const existing = region.config ?? {};
  const toggles = { ...(existing.toggles ?? {}) };
  const currency = { ...(existing.currency ?? {}) };

  // Merge toggle_ fields into toggles sub-object
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith('toggle_')) {
      toggles[k.slice(7)] = v;
    }
  }
  if (payload.coinWeightDivisor != null) currency.coinWeightDivisor = payload.coinWeightDivisor;

  const newConfig = {
    ...existing,
    toggles,
    currency,
    woundMax:             payload.woundMax             ?? existing.woundMax,
    sanityMax:            payload.sanityMax            ?? existing.sanityMax,
    sanityBreakBehavior:  payload.sanityBreakBehavior  ?? existing.sanityBreakBehavior,
    dayNightCycleTicks:   payload.dayNightCycleTicks   ?? existing.dayNightCycleTicks,
  };

  await db.region.update({ where: { id: regionId }, data: { config: newConfig } });
  logger.audit('BUILDER', 'region_config_update', { userId: ctx.userId, regionId });
  return { output: renderOutput(`[color=green]Region ${regionId} configuration updated.[/]`) };
}

// ─── Shared finalize-edit logic (called from server.js editBuffer handler) ────

export async function finalizeEdit(session) {
  const { editBuffer, editTarget } = session;
  if (!editBuffer || !editTarget) return renderOutput('[color=red]No active edit session.[/]');

  const fullText = editBuffer.join('\n');
  if (!fullText.trim()) {
    return renderOutput('[dim]Empty script — nothing saved.[/]');
  }

  const parsed = parseDSL(fullText);
  if (!parsed.ok) {
    return renderOutput(`[color=red]DSL errors — script NOT saved:[/]\n${parsed.errors.join('\n')}`);
  }

  const { type, attachId, regionId, locationId } = editTarget;
  const script = await getOrCreateScript(type, attachId, { rules: [], subroutines: {} });
  await db.script.update({ where: { id: script.id }, data: { body: parsed.body } });

  if (type === 'LOCATION') {
    await attachScriptToLocation(regionId, locationId, script.id);
  }

  logger.audit('BUILDER', 'edit_saved', { scriptId: script.id, attachId });
  return renderOutput(`[color=green]Script saved (id ${script.id}, ${parsed.body.rules?.length ?? 0} rules).[/]`);
}

// ─── Escape helper ────────────────────────────────────────────────────────────

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
