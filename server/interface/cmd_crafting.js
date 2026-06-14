// Crafting commands: craft, recipes, harvest (resource nodes)
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { enqueueAction } from '../tick/queue.js';
import { allocateInstanceId } from '../engine/idAllocator.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';

export function register() {
  registerCommand('craft',   handleCraft,   { minUserType: 'CHARACTER', group: 'crafting', description: 'Craft an item using a recipe' });
  registerCommand('recipes', handleRecipes, { minUserType: 'CHARACTER', group: 'crafting', description: 'List available recipes' });
  registerCommand('harvest', handleHarvest, { minUserType: 'CHARACTER', group: 'crafting', description: 'Harvest a resource node' });
}

// ─── craft ───────────────────────────────────────────────────────────────────

async function handleCraft(ctx) {
  if (!ctx.avatarId || !ctx.regionId) return { output: renderOutput('[color=red]No active avatar in region.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  const recipeArg = parts.slice(1).join(' ').trim();
  if (!recipeArg) return { output: renderOutput('[b]Usage:[/] craft {recipe name or #id}') };

  // Resolve recipe by id or name
  let recipe = null;
  const byId = parseInt(recipeArg.replace(/^#/, ''));
  if (!isNaN(byId)) {
    recipe = await db.recipe.findUnique({ where: { id: byId } });
  } else {
    recipe = await db.recipe.findFirst({ where: { name: { equals: recipeArg, mode: 'insensitive' } } });
  }
  if (!recipe) return { output: renderOutput(`[color=red]No recipe named '${esc(recipeArg)}'.[/]`) };

  // Region scope check
  if (recipe.regionScoped) {
    const region = await db.region.findUnique({ where: { id: ctx.regionId } });
    const regionRecipes = region?.config?.recipeIds ?? [];
    if (!regionRecipes.includes(recipe.id)) {
      return { output: renderOutput('[color=red]That recipe is not available in this region.[/]') };
    }
  }

  await enqueueAction({
    phase: 3, category: 'craft',
    resourceKey: `avatar:${ctx.avatarId}:inventory`,
    sessionToken: ctx.sessionToken,
    context: {
      sessionToken: ctx.sessionToken,
      actorAvatarId: ctx.avatarId,
      recipeId: recipe.id,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
    },
  });
  return { output: renderOutput(`You attempt to craft [b]${esc(recipe.name)}[/]...`) };
}

// ─── recipes (inline readout) ─────────────────────────────────────────────────

async function handleRecipes(ctx) {
  if (!ctx.avatarId) return { output: renderOutput('[color=red]No active avatar.[/]') };

  const all = await db.recipe.findMany({ orderBy: { name: 'asc' } });
  if (all.length === 0) return { output: renderOutput('[dim]No recipes are defined yet.[/]') };

  const avRaw = await redis.get(`avatar:${ctx.avatarId}`);
  const avatar = avRaw ? JSON.parse(avRaw) : null;
  const skills = avatar?.skills ?? {};

  let out = '[b]Known recipes:[/]\n';
  for (const r of all) {
    const canCraft = !r.skillId || skills[String(r.skillId)]?.acquired;
    const inputs = (r.inputs ?? []).map(i => `${i.quantity ?? 1}x #${i.templateId}`).join(', ');
    const outputs = (r.outputs ?? []).map(o => `${o.quantity ?? 1}x #${o.templateId}`).join(', ');
    const station = r.stationType ? ` [dim][${esc(r.stationType)}][/]` : '';
    const skillNote = r.skillId && !canCraft ? ' [color=red](skill required)[/]' : '';
    out += `  [b]#${r.id} ${esc(r.name)}[/]${station}${skillNote}\n`;
    out += `    ${inputs} → ${outputs}\n`;
  }
  return { output: renderOutput(out.trimEnd()) };
}

// ─── harvest ─────────────────────────────────────────────────────────────────

async function handleHarvest(ctx) {
  if (!ctx.avatarId || !ctx.regionId) return { output: renderOutput('[color=red]No active avatar in region.[/]') };

  const parts = ctx.raw.trim().split(/\s+/);
  const targetName = parts.slice(1).join(' ').trim();
  if (!targetName) return { output: renderOutput('[b]Usage:[/] harvest {node name}') };

  // Find resource node at current location
  const instances = await db.objectInstance.findMany({
    where: { regionId: ctx.regionId, ownerType: 'LOCATION', ownerId: String(ctx.locationId) },
    include: { template: { select: { id: true, name: true, aliases: true, baseSchema: true } } },
  });
  const node = instances.find(i => {
    if (!i.template.baseSchema?.resource) return false;
    const lc = targetName.toLowerCase();
    if (i.template.name.toLowerCase() === lc) return true;
    const al = i.template.aliases;
    if (Array.isArray(al)) return al.some(a => a.toLowerCase() === lc);
    return false;
  });
  if (!node) return { output: renderOutput(`[color=red]You don't see a harvestable '${esc(targetName)}' here.[/]`) };

  const resourceDef = node.template.baseSchema.resource;

  await enqueueAction({
    phase: 3, category: 'harvest',
    resourceKey: `instance:${node.regionId ?? 'null'}:${node.id}`,
    sessionToken: ctx.sessionToken,
    context: {
      sessionToken: ctx.sessionToken,
      actorAvatarId: ctx.avatarId,
      nodeInstanceId: node.id,
      nodeRegionId: node.regionId,
      yieldTemplateId: resourceDef.yieldTemplateId,
      yieldCount: resourceDef.yieldCount ?? 1,
      respawnTicks: resourceDef.respawnTicks ?? 20,
      skillId: resourceDef.skillId ?? null,
      regionId: ctx.regionId,
      locationId: ctx.locationId,
    },
  });
  return { output: renderOutput(`You begin harvesting [b]${esc(node.template.name)}[/]...`) };
}

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
