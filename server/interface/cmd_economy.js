// Economy commands: coins/balance (readout), buy/sell (phase 3), vendor (builder), trade (stub).
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { enqueueAction } from '../tick/queue.js';
import { logger } from '../log/logger.js';

export function register() {
  registerCommand('coins',   handleCoins,   { aliases: ['balance'], minUserType: 'CHARACTER' });
  registerCommand('buy',     handleBuy,     { minUserType: 'CHARACTER' });
  registerCommand('sell',    handleSell,    { minUserType: 'CHARACTER' });
  registerCommand('vendor',  handleVendor,  { minUserType: 'POWER_USER' });
  registerCommand('trade',   handleTrade,   { minUserType: 'CHARACTER' });
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
    // Display current vendor config
    const lines = (vendorState.stock ?? []).map(s => `  $${s.templateId} — ${s.price} coins (qty: ${s.quantity ?? '∞'})`).join('\n') || '  (empty)';
    return { output: renderOutput(`[b]Vendor $${instId}:[/]\nBuyback: ${vendorState.buyback ? 'on' : 'off'} (rate ${vendorState.buybackRate ?? 1}x)\nStock:\n${lines}`) };
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

async function _saveVendorState(inst, vendorState) {
  const newState = { ...(inst.state ?? {}), vendor: vendorState };
  await db.objectInstance.update({
    where: { regionId_id: { regionId: inst.regionId, id: inst.id } },
    data: { state: newState },
  });
}

// ─── TRADE (stub — escrow not yet implemented) ───────────────────────────────

async function handleTrade(ctx) {
  return { output: renderOutput('[color=yellow]Trade escrow is not yet implemented.[/]') };
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
