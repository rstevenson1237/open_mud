import { registerCommand } from './commands.js';
import { renderOutput, buildStatusPayload } from './output.js';
import { destroySession } from '../ws/session.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import bcrypt from 'bcryptjs';

const BCRYPT_PREFIX = '$2';

async function checkPassword(stored, candidate) {
  if (stored.startsWith(BCRYPT_PREFIX)) return bcrypt.compare(candidate, stored);
  return stored === candidate;
}

export function register() {
  // logout — destroy session and close connection
  registerCommand('logout', async (ctx) => {
    await destroySession(ctx.sessionToken);
    await db.user.update({
      where: { id: ctx.userId },
      data: { sessionToken: null, sessionExpiry: null },
    });
    return { output: renderOutput('[dim]Goodbye.[/]'), disconnect: true };
  }, {
    minUserType: 'CHARACTER',
    group: 'character',
    description: 'End your session',
  });

  // passwd — change password
  registerCommand('passwd', async (ctx) => {
    const parts = ctx.raw.trim().split(/\s+/);
    if (parts.length < 3) {
      return { output: renderOutput('[b]Usage:[/] passwd {current-password} {new-password}') };
    }
    const currentPw = parts[1];
    const newPw = parts[2];

    if (newPw.length < 8) {
      return { output: renderOutput('[color=red]New password must be at least 8 characters.[/]') };
    }

    const user = await db.user.findUnique({ where: { id: ctx.userId } });
    if (!user) return { output: renderOutput('[color=red]User not found.[/]') };

    const valid = await checkPassword(user.passwordHash, currentPw);
    if (!valid) {
      return { output: renderOutput('[color=red]Current password is incorrect.[/]') };
    }

    const newHash = await bcrypt.hash(newPw, 10);
    await db.user.update({ where: { id: ctx.userId }, data: { passwordHash: newHash } });

    return { output: renderOutput('[color=green]Password updated.[/]') };
  }, {
    minUserType: 'CHARACTER',
    group: 'character',
    description: 'Change your password',
  });

  // status — reprint current status as terminal output
  registerCommand('status', async (ctx) => {
    if (!ctx.avatarId) {
      return { output: renderOutput('[dim]No active avatar.[/]') };
    }

    const raw = await redis.get(`avatar:${ctx.avatarId}`);
    if (!raw) {
      return { output: renderOutput('[color=red]Avatar data not found.[/]') };
    }
    const avatar = JSON.parse(raw);
    const statusPayload = buildStatusPayload(avatar);
    const d = statusPayload.data;

    const name = escHtml(d.name ?? '—');
    const loc  = d.locationName ? `@ ${escHtml(d.locationName)}` : '';
    const zone = d.zoneType ? `<span class="dim">${escHtml(d.zoneType)}</span>` : '';

    const vitals = [
      `WND: ${d.wounds ?? 0}/${d.woundMax ?? 3}`,
      `SAN: ${d.sanity ?? 0}/${d.sanityMax ?? 3}`,
      `STR: ${d.stress ?? 0}`,
      `HNG: ${d.hunger ?? 0}`,
      `RST: ${d.rest ?? 0}`,
    ].join('  ');

    const stats = d.stats ? [
      `PHY  FOR:${d.stats.phy_for ?? '—'} PRE:${d.stats.phy_pre ?? '—'} RES:${d.stats.phy_res ?? '—'}`,
      `MEN  FOR:${d.stats.men_for ?? '—'} PRE:${d.stats.men_pre ?? '—'} RES:${d.stats.men_res ?? '—'}`,
      `SOC  FOR:${d.stats.soc_for ?? '—'} PRE:${d.stats.soc_pre ?? '—'} RES:${d.stats.soc_res ?? '—'}`,
    ].join('  ') : '';

    const conds = (d.conditions ?? []).length
      ? `<span class="c-yellow">${escHtml((d.conditions ?? []).join(', '))}</span>`
      : '<span class="dim">none</span>';

    const lines = [
      `<strong>${name}</strong>  ${loc}  ${zone}`,
      `<span class="dim">${escHtml(vitals)}</span>`,
      stats ? `<span class="dim">${escHtml(stats)}</span>` : null,
      `Conditions: ${conds}`,
    ].filter(Boolean);

    return {
      output: lines.join('<br>'),
      status: statusPayload,
    };
  }, {
    minUserType: 'CHARACTER',
    group: 'character',
    description: 'Display your current status',
  });
}

function escHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
