// Economy engine: purchase (buy) and sale (sell) handlers for phase 3.
// Register purchaseHandler and saleHandler via registerSystemHandler in engine.js.
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { markDirty } from '../db/sync.js';
import { renderOutput } from '../interface/output.js';
import { logger } from '../log/logger.js';

// ─── Coin helpers ─────────────────────────────────────────────────────────────

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
  return remaining === 0;
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
    // Find a COIN template in the region
    const tmpl = await db.objectTemplate.findFirst({ where: { regionId, type: 'COIN' } })
      ?? await db.objectTemplate.findFirst({ where: { type: 'COIN' } });
    if (!tmpl) return false;
    const maxId = await db.objectInstance.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } });
    const newId = (maxId?.id ?? 0) + 1;
    await db.objectInstance.create({
      data: { id: newId, regionId, templateId: tmpl.id, ownerType: 'AVATAR', ownerId: String(avatarId), count: amount, state: {}, isState: {}, metadata: {} },
    });
  }
  return true;
}

// ─── Vendor state helpers ─────────────────────────────────────────────────────

async function _getVendorInLocation(regionId, locationId) {
  const insts = await db.objectInstance.findMany({
    where: { regionId, ownerType: 'LOCATION', ownerId: String(locationId) },
    include: { template: { select: { type: true } } },
  });
  return insts.find(i => i.template?.type === 'MOB' && i.state?.vendor) ?? null;
}

// ─── purchaseHandler ──────────────────────────────────────────────────────────

export const purchaseHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    const { sessionToken, actorAvatarId, vendorInstanceId, vendorRegionId, templateId, price, regionId, locationId } = ctx;

    const avRaw = await redis.get(`avatar:${actorAvatarId}`);
    if (!avRaw) return;
    const avatar = JSON.parse(avRaw);

    // Verify vendor still in location
    const vendor = await db.objectInstance.findFirst({
      where: { regionId: vendorRegionId ?? regionId, id: vendorInstanceId },
    });
    if (!vendor?.state?.vendor) {
      sendOutput([sessionToken], renderOutput('[color=red]That vendor is no longer here.[/]'));
      return;
    }

    const stock = vendor.state.vendor.stock ?? [];
    const entry = stock.find(s => s.templateId === templateId);
    if (!entry) {
      sendOutput([sessionToken], renderOutput('[color=red]That item is no longer in stock.[/]'));
      return;
    }

    const total = await _getCoinTotal(actorAvatarId);
    if (total < price) {
      sendOutput([sessionToken], renderOutput(`[color=red]You need ${price} coins but only have ${total}.[/]`));
      return;
    }

    // Deduct coins
    await _deductCoins(actorAvatarId, price);

    // Create item instance in avatar's inventory
    const newId = ((await db.objectInstance.findFirst({ where: { regionId }, orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? 0) + 1;
    const tmpl = await db.objectTemplate.findUnique({ where: { id: templateId } });
    await db.objectInstance.create({
      data: { id: newId, regionId, templateId, ownerType: 'AVATAR', ownerId: String(actorAvatarId), count: 1, state: {}, isState: {}, metadata: {} },
    });
    markDirty('instance', `${regionId}:${newId}`);

    // Decrement quantity if finite (-1 = infinite)
    if ((entry.quantity ?? -1) > 0) {
      const updatedStock = stock.map(s => s.templateId === templateId ? { ...s, quantity: s.quantity - 1 } : s);
      const newVendorState = { ...vendor.state, vendor: { ...vendor.state.vendor, stock: updatedStock } };
      await db.objectInstance.update({
        where: { regionId_id: { regionId: vendor.regionId, id: vendor.id } },
        data: { state: newVendorState },
      });
    }

    sendOutput([sessionToken], renderOutput(`[color=green]You buy [b]${esc(tmpl?.name ?? `item ${templateId}`)}[/] for ${price} coins.[/]`));
    emit('avatar', String(actorAvatarId), 'on_purchase', { avatarId: actorAvatarId, templateId, price, regionId, locationId });
    logger.info('ECONOMY', 'purchase', { avatarId: actorAvatarId, templateId, price });
  },
};

// ─── saleHandler ─────────────────────────────────────────────────────────────

export const saleHandler = {
  async apply(action, _result, emit, tick, sendOutput) {
    const ctx = action.context ?? {};
    const { sessionToken, actorAvatarId, instanceId, instanceRegionId, vendorInstanceId, vendorRegionId, regionId, locationId } = ctx;

    const vendor = await db.objectInstance.findFirst({
      where: { regionId: vendorRegionId ?? regionId, id: vendorInstanceId },
    });
    if (!vendor?.state?.vendor?.buyback) {
      sendOutput([sessionToken], renderOutput('[color=red]That vendor does not buy items.[/]'));
      return;
    }

    const inst = await db.objectInstance.findFirst({
      where: { regionId: instanceRegionId ?? regionId, id: instanceId, ownerType: 'AVATAR', ownerId: String(actorAvatarId) },
      include: { template: { select: { name: true, type: true, weight: true } } },
    });
    if (!inst) {
      sendOutput([sessionToken], renderOutput('[color=red]You are not carrying that.[/]'));
      return;
    }
    if (inst.template?.type === 'COIN') {
      sendOutput([sessionToken], renderOutput('[color=red]You cannot sell coins.[/]'));
      return;
    }

    // Determine buyback price
    const buybackPrice = vendor.state.vendor.buybackRate
      ? Math.floor((inst.template?.weight ?? 1) * vendor.state.vendor.buybackRate)
      : 1;

    // Remove item, give coins
    await db.objectInstance.delete({ where: { regionId_id: { regionId: inst.regionId, id: inst.id } } });
    await _addCoins(actorAvatarId, buybackPrice, regionId);

    sendOutput([sessionToken], renderOutput(`[color=green]You sell [b]${esc(inst.template?.name ?? `item ${instanceId}`)}[/] for ${buybackPrice} coins.[/]`));
    emit('avatar', String(actorAvatarId), 'on_sale', { avatarId: actorAvatarId, instanceId, buybackPrice, regionId, locationId });
    logger.info('ECONOMY', 'sale', { avatarId: actorAvatarId, instanceId, buybackPrice });
  },
};

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
