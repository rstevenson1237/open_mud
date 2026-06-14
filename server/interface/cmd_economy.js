// Economy commands: coins/balance (readout), buy/sell (phase 3), vendor (builder), trade escrow.
import { registerCommand } from './commands.js';
import { registerPanelRoute } from './panels.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { enqueueAction } from '../tick/queue.js';
import { tradeKey } from '../engine/trade.js';
import { logger } from '../log/logger.js';

export function register() {
  registerCommand('coins',   handleCoins,        { aliases: ['balance'], minUserType: 'CHARACTER',  group: 'economy', description: 'Show your coin count' });
  registerCommand('buy',     handleBuy,          {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Buy from a vendor' });
  registerCommand('sell',    handleSell,         {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Sell to a vendor' });
  registerCommand('vendor',  handleVendor,       {                       minUserType: 'POWER_USER', group: 'world',   description: 'Configure a vendor instance' });
  registerCommand('trade',   handleTrade,        {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Open a trade with another player' });
  registerCommand('offer',   handleOffer,        {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Offer an item or coins in a trade' });
  registerCommand('confirm', handleTradeConfirm, {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Confirm the current trade' });
  registerCommand('cancel',  handleTradeCancel,  {                       minUserType: 'CHARACTER',  group: 'economy', description: 'Cancel the current trade' });

  registerPanelRoute('vendor_config', handleVendorConfigSubmit);
}

// ─── COINS / BALANCE (readout — inline) ───────────────────────────────────────

async function handleCoins(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };

  const insts = await db.objectInstance.findMany({
    where: { ownerType: 'AVATAR', ownerId: String(ctx.avatarId) },
    include: { template: { select: { type: true } } },
  });
  const total = insts.filter(i => i.template?.type === 'COIN').reduce((s, i) => s + (i.count ?? 1), 0);
  return { output: renderOutput(`You are carrying [b]${total}[/] coin${total !== 1 ? 's' : ''}.`) };
}

// ─── BUY (phase 3) ───────────────────────────────────────────────────────────

async function handleBuy(ctx) {
  if (!ctx.avatarId || !ctx.regionId) return { output: renderOutput('[color=red]No active avatar in region.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  // buy {item_name_or_id} [from $vendorRef]
  const fromIdx = parts.findIndex(p => p.toLowerCase() === 'from');
  const itemArg = parts.slice(1, fromIdx > 1 ? fromIdx : undefined).join(' ').trim();
  const vendorArg = fromIdx > 0 ? parts[fromIdx + 1] : null;

  if (!itemArg) return { output: renderOutput('[b]Usage:[/] buy {item} [from $vendorId]') };

  const vendor = await _findVendor(ctx.regionId, ctx.locationId, vendorArg);
  if (!vendor) return { output: renderOutput('[color=red]No vendor here.[/]') };

  const stock = vendor.state?.vendor?.stock ?? [];
  const entry = _findStockEntry(stock, itemArg);
  if (!entry) return { output: renderOutput(`[color=red]'${esc(itemArg)}' is not available here.[/]`) };
  if ((entry.quantity ?? -1) === 0) return { output: renderOutput(`[color=red]That item is sold out.[/]`) };

  await enqueueAction({
    phase: 3, category: 'purchase',
    resourceKey: `avatar:${ctx.avatarId}:coins`,
    sessionToken: ctx.sessionToken,
    context: {
      sessionToken: ctx.sessionToken,
      actorAvatarId: ctx.avatarId,
      vendorInstanceId: vendor.id,
      vendorRegionId: vendor.regionId,
      templateId: entry.templateId,
      price: entry.price,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
    },
  });

  const tmpl = await db.objectTemplate.findUnique({ where: { id: entry.templateId } }).catch(() => null);
  return { output: renderOutput(`You offer to buy [b]${esc(tmpl?.name ?? itemArg)}[/] for ${entry.price} coins...`) };
}

// ─── SELL (phase 3) ──────────────────────────────────────────────────────────

async function handleSell(ctx) {
  if (!ctx.avatarId || !ctx.regionId) return { output: renderOutput('[color=red]No active avatar in region.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  // sell $instId [to $vendorRef]
  const toIdx = parts.findIndex(p => p.toLowerCase() === 'to');
  const instArg = parts.slice(1, toIdx > 1 ? toIdx : undefined).join(' ').trim();
  const vendorArg = toIdx > 0 ? parts[toIdx + 1] : null;

  if (!instArg) return { output: renderOutput('[b]Usage:[/] sell $instId [to $vendorId]') };

  const instId = parseInt(instArg.replace(/^[$#]/, ''));
  if (isNaN(instId)) return { output: renderOutput('[color=red]Specify an instance id: sell $42[/]') };

  const vendor = await _findVendor(ctx.regionId, ctx.locationId, vendorArg);
  if (!vendor) return { output: renderOutput('[color=red]No vendor here.[/]') };
  if (!vendor.state?.vendor?.buyback) return { output: renderOutput('[color=red]That vendor does not buy items.[/]') };

  // Verify item is in avatar's inventory
  const inst = await db.objectInstance.findFirst({
    where: { regionId: ctx.regionId, id: instId, ownerType: 'AVATAR', ownerId: String(ctx.avatarId) },
    include: { template: { select: { name: true } } },
  });
  if (!inst) return { output: renderOutput('[color=red]You are not carrying that.[/]') };

  await enqueueAction({
    phase: 3, category: 'sale',
    resourceKey: `instance:${ctx.regionId}:${instId}`,
    sessionToken: ctx.sessionToken,
    context: {
      sessionToken: ctx.sessionToken,
      actorAvatarId: ctx.avatarId,
      instanceId: instId,
      instanceRegionId: ctx.regionId,
      vendorInstanceId: vendor.id,
      vendorRegionId: vendor.regionId,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
    },
  });

  return { output: renderOutput(`You offer to sell [b]${esc(inst.template?.name ?? `item ${instId}`)}[/]...`) };
}

// ─── VENDOR (POWER_USER builder command) ─────────────────────────────────────

async function handleVendor(ctx) {
  if (!ctx.regionId) return { output: renderOutput('[color=red]No active region.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  const instArg = parts[1];
  const sub = parts[2]?.toLowerCase();
  if (!instArg) return { output: renderOutput('[b]Usage:[/] vendor $instId [add $tplId {price} [qty]] | [remove $tplId] | [buyback on|off] | [rate {N}]') };

  const instId = parseInt(instArg.replace(/^[$#]/, ''));
  if (isNaN(instId)) return { output: renderOutput('[color=red]Invalid instance id.[/]') };

  const inst = await db.objectInstance.findFirst({ where: { regionId: ctx.regionId, id: instId } });
  if (!inst) return { output: renderOutput(`[color=red]Instance $${instId} not found.[/]`) };

  const vendorState = inst.state?.vendor ?? { stock: [], buyback: false, buybackRate: 1 };

  if (!sub) {
    // Store vendor target in session for submit handler
    const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
    if (sessionRaw) {
      const session = JSON.parse(sessionRaw);
      session.pendingVendorTarget = { regionId: ctx.regionId, instId };
      await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));
    }

    return {
      panel: {
        handlerKey: 'vendor_config',
        descriptor: {
          title: `Vendor $${instId} Configuration`,
          fields: [
            { key: 'buyback',     type: 'checkbox', label: 'Enable Buyback', default: vendorState.buyback ?? false },
            {
              key: 'buybackRate', type: 'range', label: 'Buyback Rate',
              min: 0.1, max: 2.0, step: 0.1, default: vendorState.buybackRate ?? 1.0,
              displayFormat: '{value}x',
            },
            {
              key: 'stock',
              type: 'keyvalue-list',
              label: 'Stock',
              columns: [
                { key: 'templateId', label: 'Template $ID', type: 'number', min: 1 },
                { key: 'price',      label: 'Price (coins)', type: 'number', min: 0 },
                { key: 'quantity',   label: 'Qty (−1 = ∞)',  type: 'number', default: -1 },
              ],
              default: vendorState.stock ?? [],
            },
          ],
        },
      },
    };
  }

  if (sub === 'add') {
    const tplArg = parts[3];
    const priceArg = parts[4];
    const qtyArg = parts[5];
    const tplId = parseInt((tplArg ?? '').replace(/^[$#]/, ''));
    const price = parseInt(priceArg ?? '0');
    if (isNaN(tplId) || price < 0) return { output: renderOutput('[b]Usage:[/] vendor $instId add $tplId {price} [quantity]') };
    const qty = qtyArg ? parseInt(qtyArg) : -1;

    const existing = (vendorState.stock ?? []).findIndex(s => s.templateId === tplId);
    const newStock = [...(vendorState.stock ?? [])];
    if (existing >= 0) { newStock[existing] = { templateId: tplId, price, quantity: qty }; }
    else newStock.push({ templateId: tplId, price, quantity: qty });

    await _saveVendorState(inst, { ...vendorState, stock: newStock });
    logger.audit('ECONOMY', 'vendor_add_stock', { userId: ctx.userId, instId, tplId, price });
    return { output: renderOutput(`[color=green]Added $${tplId} to vendor at ${price} coins (qty: ${qty < 0 ? '∞' : qty}).[/]`) };
  }

  if (sub === 'remove') {
    const tplArg = parts[3];
    const tplId = parseInt((tplArg ?? '').replace(/^[$#]/, ''));
    if (isNaN(tplId)) return { output: renderOutput('[b]Usage:[/] vendor $instId remove $tplId') };
    const newStock = (vendorState.stock ?? []).filter(s => s.templateId !== tplId);
    await _saveVendorState(inst, { ...vendorState, stock: newStock });
    return { output: renderOutput(`[color=green]Removed $${tplId} from vendor stock.[/]`) };
  }

  if (sub === 'buyback') {
    const onOff = parts[3]?.toLowerCase();
    if (onOff !== 'on' && onOff !== 'off') return { output: renderOutput('[b]Usage:[/] vendor $instId buyback on|off') };
    await _saveVendorState(inst, { ...vendorState, buyback: onOff === 'on' });
    return { output: renderOutput(`[color=green]Vendor buyback ${onOff}.[/]`) };
  }

  if (sub === 'rate') {
    const rate = parseFloat(parts[3] ?? '');
    if (isNaN(rate) || rate <= 0) return { output: renderOutput('[b]Usage:[/] vendor $instId rate {multiplier}') };
    await _saveVendorState(inst, { ...vendorState, buybackRate: rate });
    return { output: renderOutput(`[color=green]Vendor buyback rate set to ${rate}x.[/]`) };
  }

  return { output: renderOutput('[b]Usage:[/] vendor $instId [add|remove|buyback|rate] ...') };
}

async function handleVendorConfigSubmit(ctx, payload) {
  const sessionRaw = await redis.get(`session:${ctx.sessionToken}`);
  if (!sessionRaw) return { output: renderOutput('[color=red]Session not found.[/]') };
  const session = JSON.parse(sessionRaw);
  const target = session.pendingVendorTarget;
  delete session.pendingVendorTarget;
  await redis.set(`session:${ctx.sessionToken}`, JSON.stringify(session));

  if (!target) return { output: renderOutput('[color=red]No vendor target in session.[/]') };

  const inst = await db.objectInstance.findFirst({ where: { regionId: target.regionId, id: target.instId } });
  if (!inst) return { output: renderOutput(`[color=red]Instance $${target.instId} not found.[/]`) };

  const { buyback, buybackRate, stock } = payload;
  const newVendorState = {
    ...(inst.state?.vendor ?? {}),
    buyback: buyback ?? false,
    buybackRate: buybackRate ?? 1.0,
    stock: (stock ?? []).map(row => ({
      templateId: parseInt(row.templateId) || 0,
      price:      parseInt(row.price)      || 0,
      quantity:   parseInt(row.quantity)   ?? -1,
    })),
  };

  await _saveVendorState(inst, newVendorState);
  logger.audit('ECONOMY', 'vendor_config_update', { userId: ctx.userId, instId: target.instId });
  return { output: renderOutput(`[color=green]Vendor $${target.instId} configuration saved.[/]`) };
}

async function _saveVendorState(inst, vendorState) {
  const newState = { ...(inst.state ?? {}), vendor: vendorState };
  await db.objectInstance.update({
    where: { regionId_id: { regionId: inst.regionId, id: inst.id } },
    data: { state: newState },
  });
}

// ─── TRADE ESCROW ─────────────────────────────────────────────────────────────

async function _getAvatarEscrowKey(avatarId) {
  const keys = await redis.keys('trade:*');
  for (const k of keys) {
    const raw = await redis.get(k);
    if (!raw) continue;
    const e = JSON.parse(raw);
    if (e.a?.avatarId === avatarId || e.b?.avatarId === avatarId) return k;
  }
  return null;
}

async function _getAvatarEscrow(avatarId) {
  const key = await _getAvatarEscrowKey(avatarId);
  if (!key) return null;
  const raw = await redis.get(key);
  return raw ? { key, escrow: JSON.parse(raw) } : null;
}

function _mySide(escrow, avatarId) {
  return escrow.a.avatarId === avatarId ? 'a' : 'b';
}

function _otherSide(side) { return side === 'a' ? 'b' : 'a'; }

async function handleTrade(ctx) {
  if (!ctx.avatarId || !ctx.regionId) return { output: renderOutput('[color=red]No active avatar.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  const targetArg = (parts[1] ?? '').replace(/^@/, '');
  if (!targetArg) return { output: renderOutput('[b]Usage:[/] trade @player') };

  // Check if already in a trade
  if (await _getAvatarEscrowKey(ctx.avatarId)) {
    return { output: renderOutput('[color=red]You are already in a trade. Use cancel first.[/]') };
  }

  // Resolve target avatar co-located
  const targetAv = await db.avatar.findFirst({
    where: { name: { equals: targetArg, mode: 'insensitive' }, isActive: true, regionId: ctx.regionId, locationId: ctx.locationId },
    select: { id: true, name: true, userId: true },
  });
  if (!targetAv) return { output: renderOutput(`[color=red]'${esc(targetArg)}' is not here.[/]`) };
  if (targetAv.id === ctx.avatarId) return { output: renderOutput('[color=red]You cannot trade with yourself.[/]') };

  // Check if target already in a trade
  if (await _getAvatarEscrowKey(targetAv.id)) {
    return { output: renderOutput(`[color=red]${esc(targetAv.name)} is already in a trade.[/]`) };
  }

  const targetUser = await db.user.findUnique({ where: { id: targetAv.userId }, select: { sessionToken: true } });
  const key = tradeKey(ctx.avatarId, targetAv.id);
  const [sideA, sideB] = ctx.avatarId < targetAv.id
    ? [{ avatarId: ctx.avatarId, sessionToken: ctx.sessionToken, items: [], coins: 0, confirmed: false },
       { avatarId: targetAv.id, sessionToken: targetUser?.sessionToken ?? null, items: [], coins: 0, confirmed: false }]
    : [{ avatarId: targetAv.id, sessionToken: targetUser?.sessionToken ?? null, items: [], coins: 0, confirmed: false },
       { avatarId: ctx.avatarId, sessionToken: ctx.sessionToken, items: [], coins: 0, confirmed: false }];

  const escrow = { a: sideA, b: sideB, openedTick: 0, regionId: ctx.regionId, locationId: ctx.locationId };
  await redis.set(key, JSON.stringify(escrow));

  // Read currentTick from Redis for the timeout
  const tickRaw = await redis.get('world:tickCount');
  escrow.openedTick = tickRaw ? parseInt(tickRaw) : 0;
  await redis.set(key, JSON.stringify(escrow));

  const msg = renderOutput(`[color=green]A trade window is open with [b]${esc(targetAv.name)}[/]. Use [b]offer[/], [b]confirm[/], or [b]cancel[/].[/]`);
  const targetMsg = renderOutput(`[color=green][b]${esc(ctx.avatarName ?? 'Someone')}[/] has opened a trade with you. Use [b]offer[/], [b]confirm[/], or [b]cancel[/].[/]`);
  if (targetUser?.sessionToken) {
    // Best-effort: we can't sendOutput from here (not in worker thread); relay via output field
  }
  logger.info('TRADE', 'Trade opened', { key, avatarA: ctx.avatarId, avatarB: targetAv.id });
  return { output: msg };
}

async function handleOffer(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const result = await _getAvatarEscrow(ctx.avatarId);
  if (!result) return { output: renderOutput('[color=red]You are not in a trade.[/]') };
  const { key, escrow } = result;
  const mySide = _mySide(escrow, ctx.avatarId);
  const party = escrow[mySide];

  const parts = ctx.raw.trim().split(/\s+/);
  // offer {N} coins   or   offer $instId
  if (parts.length < 2) return { output: renderOutput('[b]Usage:[/] offer $item | offer {N} coins') };

  const isCoins = parts[parts.length - 1]?.toLowerCase() === 'coins';
  if (isCoins) {
    const amount = parseInt(parts[1]);
    if (isNaN(amount) || amount < 0) return { output: renderOutput('[color=red]Invalid coin amount.[/]') };
    party.coins = amount;
    // Any change invalidates both confirmations
    escrow.a.confirmed = false;
    escrow.b.confirmed = false;
    await redis.set(key, JSON.stringify(escrow));
    return { output: renderOutput(`You offer [b]${amount}[/] coins.`) };
  }

  // Offer an item
  const instArg = parts[1];
  const instId = parseInt(instArg.replace(/^[$#]/, ''));
  if (isNaN(instId)) return { output: renderOutput('[b]Usage:[/] offer $instId | offer {N} coins') };

  // Verify the item is in the avatar's inventory
  const inst = await db.objectInstance.findFirst({
    where: { id: instId, ownerType: 'AVATAR', ownerId: String(ctx.avatarId) },
    include: { template: { select: { name: true } } },
  });
  if (!inst) return { output: renderOutput(`[color=red]You are not carrying $${instId}.[/]`) };

  // Move to ESCROW
  await db.objectInstance.update({
    where: { regionId_id: { regionId: inst.regionId, id: inst.id } },
    data: { ownerType: 'ESCROW', ownerId: key },
  });
  party.items = [...(party.items ?? []), inst.id];
  escrow.a.confirmed = false;
  escrow.b.confirmed = false;
  await redis.set(key, JSON.stringify(escrow));
  return { output: renderOutput(`You offer [b]${esc(inst.template?.name ?? `item ${instId}`)}[/].`) };
}

async function handleTradeConfirm(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const result = await _getAvatarEscrow(ctx.avatarId);
  if (!result) return { output: renderOutput('[color=red]You are not in a trade.[/]') };
  const { key, escrow } = result;
  const mySide = _mySide(escrow, ctx.avatarId);

  escrow[mySide].confirmed = true;
  await redis.set(key, JSON.stringify(escrow));

  if (escrow.a.confirmed && escrow.b.confirmed) {
    // Both confirmed: enqueue atomic transfer in phase 3
    await enqueueAction({
      phase: 3, category: 'trade_confirm',
      resourceKey: null,
      sessionToken: ctx.sessionToken,
      context: { tradeKey: key, actorAvatarId: ctx.avatarId },
    });
    return { output: renderOutput('[color=green]Both parties confirmed. Completing trade...[/]') };
  }

  return { output: renderOutput('[color=green]You confirmed the trade. Waiting for the other party...[/]') };
}

async function handleTradeCancel(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };
  const result = await _getAvatarEscrow(ctx.avatarId);
  if (!result) return { output: renderOutput('[color=red]You are not in a trade.[/]') };
  const { key, escrow } = result;

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
        logger.warn('TRADE', 'Item return failed on cancel', { instanceId, error: e.message });
      }
    }
  }
  await redis.del(key);
  logger.info('TRADE', 'Trade cancelled by avatar', { key, avatarId: ctx.avatarId });
  return { output: renderOutput('[color=yellow]Trade cancelled. Your items have been returned.[/]') };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _findVendor(regionId, locationId, vendorArg) {
  if (vendorArg) {
    const id = parseInt(vendorArg.replace(/^[$#]/, ''));
    if (!isNaN(id)) {
      const inst = await db.objectInstance.findFirst({ where: { regionId, id } });
      return inst?.state?.vendor ? inst : null;
    }
  }
  const insts = await db.objectInstance.findMany({
    where: { regionId, ownerType: 'LOCATION', ownerId: String(locationId) },
  });
  return insts.find(i => i.state?.vendor) ?? null;
}

function _findStockEntry(stock, itemArg) {
  const byId = parseInt(itemArg.replace(/^[$#]/, ''));
  if (!isNaN(byId)) return stock.find(s => s.templateId === byId) ?? null;
  // fallback: can't match by name at enqueue time (no template join here);
  // caller should pass $templateId for reliable lookup
  return null;
}

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
