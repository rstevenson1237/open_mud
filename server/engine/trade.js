// Trade escrow engine: atomic transfer handler and reaper maintenance task.
// Registered as system handler 'trade_confirm' and maintenance task 'tradeReaper' in engine.js.
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

function tradeKey(a, b) {
  return `trade:${Math.min(a, b)}-${Math.max(a, b)}`;
}

async function _getEscrow(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function _saveEscrow(key, escrow) {
  await redis.set(key, JSON.stringify(escrow));
}

async function _cancelEscrow(key, escrow, sendOutput, reason) {
  // Return ESCROW-held items to their owners
  for (const side of ['a', 'b']) {
    const party = escrow[side];
    for (const instanceId of (party.items ?? [])) {
      try {
        await db.objectInstance.updateMany({
          where: { ownerType: 'ESCROW', ownerId: key, id: instanceId },
          data: { ownerType: 'AVATAR', ownerId: String(party.avatarId) },
        });
      } catch (e) {
        logger.warn('TRADE', 'Item return failed', { instanceId, avatarId: party.avatarId, error: e.message });
      }
    }
    if (sendOutput && party.sessionToken) {
      sendOutput([party.sessionToken], renderOutput(`[color=yellow]Trade cancelled${reason ? ': ' + reason : ''}.[/]`));
    }
  }
  await redis.del(key);
  logger.info('TRADE', 'Escrow cancelled', { key, reason });
}

// Called by tradeReaper to cancel stale trades
export async function cancelEscrowByKey(key, sendOutput) {
  const escrow = await _getEscrow(key);
  if (!escrow) return;
  await _cancelEscrow(key, escrow, sendOutput, 'timed out');
}

// ─── tradeConfirmHandler ─────────────────────────────────────────────────────

export const tradeConfirmHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    const { tradeKey: key } = action.context ?? {};
    if (!key) return;

    const escrow = await _getEscrow(key);
    if (!escrow) return;

    // Both must still be confirmed
    if (!escrow.a.confirmed || !escrow.b.confirmed) return;

    // Verify both parties are still co-located
    const avA = await db.avatar.findUnique({ where: { id: escrow.a.avatarId }, select: { regionId: true, locationId: true } });
    const avB = await db.avatar.findUnique({ where: { id: escrow.b.avatarId }, select: { regionId: true, locationId: true } });
    if (!avA || !avB || avA.regionId !== avB.regionId || avA.locationId !== avB.locationId) {
      await _cancelEscrow(key, escrow, sendOutput, 'parties are no longer co-located');
      return;
    }

    // Verify coin balances
    if (escrow.a.coins > 0) {
      const totalA = await _getCoinTotal(escrow.a.avatarId);
      if (totalA < escrow.a.coins) {
        await _cancelEscrow(key, escrow, sendOutput, `${escrow.a.avatarId} has insufficient coins`);
        return;
      }
    }
    if (escrow.b.coins > 0) {
      const totalB = await _getCoinTotal(escrow.b.avatarId);
      if (totalB < escrow.b.coins) {
        await _cancelEscrow(key, escrow, sendOutput, `${escrow.b.avatarId} has insufficient coins`);
        return;
      }
    }

    // Atomic transfer: items go to the other party
    for (const instanceId of (escrow.a.items ?? [])) {
      await db.objectInstance.updateMany({
        where: { ownerType: 'ESCROW', ownerId: key, id: instanceId },
        data: { ownerType: 'AVATAR', ownerId: String(escrow.b.avatarId) },
      });
    }
    for (const instanceId of (escrow.b.items ?? [])) {
      await db.objectInstance.updateMany({
        where: { ownerType: 'ESCROW', ownerId: key, id: instanceId },
        data: { ownerType: 'AVATAR', ownerId: String(escrow.a.avatarId) },
      });
    }

    // Transfer coins
    if (escrow.a.coins > 0) {
      await _deductCoins(escrow.a.avatarId, escrow.a.coins);
      await _addCoins(escrow.b.avatarId, escrow.a.coins, escrow.regionId);
    }
    if (escrow.b.coins > 0) {
      await _deductCoins(escrow.b.avatarId, escrow.b.coins);
      await _addCoins(escrow.a.avatarId, escrow.b.coins, escrow.regionId);
    }

    await redis.del(key);

    const msg = renderOutput('[color=green]Trade complete.[/]');
    sendOutput([escrow.a.sessionToken], msg);
    sendOutput([escrow.b.sessionToken], msg);
    logger.info('TRADE', 'Trade complete', { key });
  },
};

// ─── tradeReaper (maintenance task) ─────────────────────────────────────────

export async function tradeReaper(currentTick, _emit) {
  const keys = await redis.keys('trade:*');
  for (const key of keys) {
    const escrow = await _getEscrow(key);
    if (!escrow) continue;
    if (currentTick >= escrow.openedTick + 10) {
      await _cancelEscrow(key, escrow, null, 'timed out');
    }
  }
}

// ─── Coin helpers (reused from economy.js pattern) ───────────────────────────

async function _getCoinTotal(avatarId) {
  const coins = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { type: true } } },
  });
  return coins.filter(c => c.template?.type === 'COIN').reduce((s, c) => s + (c.count ?? 1), 0);
}

async function _deductCoins(avatarId, amount) {
  const coins = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { type: true } } },
  });
  const coinInsts = coins.filter(c => c.template?.type === 'COIN');
  let remaining = amount;
  for (const c of coinInsts) {
    if (remaining <= 0) break;
    const take = Math.min(c.count ?? 1, remaining);
    remaining -= take;
    const newCount = (c.count ?? 1) - take;
    if (newCount <= 0) {
      await db.objectInstance.delete({ where: { regionId_id: { regionId: c.regionId, id: c.id } } });
    } else {
      await db.objectInstance.update({ where: { regionId_id: { regionId: c.regionId, id: c.id } }, data: { count: newCount } });
    }
  }
}

async function _addCoins(avatarId, amount, regionId) {
  const coinInsts = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(avatarId) },
    include: { template: { select: { type: true } } },
  });
  const coin = coinInsts.find(c => c.template?.type === 'COIN');
  if (coin) {
    await db.objectInstance.update({
      where: { regionId_id: { regionId: coin.regionId, id: coin.id } },
      data: { count: (coin.count ?? 1) + amount },
    });
  } else {
    const tmpl = await db.objectTemplate.findFirst({ where: { regionId, type: 'COIN' } })
      ?? await db.objectTemplate.findFirst({ where: { type: 'COIN' } });
    if (!tmpl) return;
    const maxId = await db.objectInstance.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
    const newId = (maxId?.id ?? 0) + 1;
    await db.objectInstance.create({
      data: { id: newId, regionId, templateId: tmpl.id, ownerType: 'AVATAR', ownerId: String(avatarId), count: amount, state: {}, isState: {}, metadata: {} },
    });
  }
}

export { tradeKey };
