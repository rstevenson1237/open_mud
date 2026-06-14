// Seed content: The Test Vale — Region 100
// This seed creates a deterministic test region that exercises every Phase 3 system.
// Run order: conditions.js → skills.js → world_config.js → recipes.js → quests.js → test_vale.js
// Idempotent: upserts by stable IDs. Re-running produces no duplicates.
//
// Stable IDs used (all in region 100):
//   Region:    100
//   Locations: 100:1 Vale Gate (SAFE, entry)
//              100:2 Market Row (SAFE, vendor + quest-giver NPC)
//              100:3 Forge Yard (SAFE, FORGE station)
//              100:4 Herb Hollow (OPEN, herb resource nodes + ALCHEMY station)
//              100:5 The Warren (DANGEROUS, 3 killable warren goblins)
//              100:6 Locked Vault (SAFE, gated by lever puzzle)
//   Object Templates (global, regionId null for cross-region usability):
//     1001 stick (ITEM), 1002 cloth (ITEM), 1003 torch (ITEM, CONSUMABLE)
//     1004 herb (ITEM), 1005 healing_draught (CONSUMABLE), 1006 iron_ore (ITEM)
//     1007 iron_dagger (WEAPON), 1008 coin (COIN)
//     2001 warren_goblin (MOB), 2002 alchemist_npc (MOB)
//     3001 forge_station (FIXTURE), 3002 alchemy_station (FIXTURE)
//     3003 herb_node (FIXTURE, resource node), 3004 chest_template (CONTAINER)
//     3005 lever (ITEM/FIXTURE, puzzle object)
//   Scripts: attached to locations and instances via scriptId

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// ─── Object template upsert helper ───────────────────────────────────────────

async function upsertTemplate(data) {
  const existing = await db.objectTemplate.findUnique({ where: { id: data.id } });
  if (existing) {
    await db.objectTemplate.update({ where: { id: data.id }, data });
  } else {
    await db.objectTemplate.create({ data });
  }
  console.log(`Template ${data.id}: ${data.name}`);
}

// ─── Script creation helper ───────────────────────────────────────────────────

async function createScript(body, opts = {}) {
  const script = await db.script.create({
    data: {
      attachedToType: opts.attachedToType ?? 'LOCATION',
      attachedToId:   opts.attachedToId ?? '100:1',
      body,
      metadata: {},
    },
  });
  return script.id;
}

// ─── Region setup ─────────────────────────────────────────────────────────────

async function upsertRegion() {
  const config = {
    entryLocationId: 1,
    toggles: { combat: true, pvp: false, hunger: false, rest: false, wounds: true, stress: true, skills: true, crafting: true, story: true },
    dayNightCycleTicks: 20,
    defaultZoneType: 'SAFE',
    deathBehavior: 'respawn_region_entry',
    skillIds: [1, 2],
    conditionIds: [],
    currency: { base: 'coin', denominations: [] },
    questIds: [],
    recipeIds: [],
  };
  const existing = await db.region.findUnique({ where: { id: 100 } });
  if (existing) {
    await db.region.update({ where: { id: 100 }, data: { name: 'The Test Vale', config } });
  } else {
    await db.region.create({ data: { id: 100, name: 'The Test Vale', config } });
  }
  console.log('Region 100: The Test Vale');
}

// ─── Location upsert helper ───────────────────────────────────────────────────

async function upsertLocation(id, name, description, zoneType, extra = {}) {
  const data = { id, regionId: 100, name, description, zoneType, ...extra };
  const existing = await db.location.findUnique({ where: { regionId_id: { regionId: 100, id } } });
  if (existing) {
    await db.location.update({ where: { regionId_id: { regionId: 100, id } }, data: { name, description, zoneType, ...extra } });
  } else {
    await db.location.create({ data });
  }
  console.log(`Location 100:${id}: ${name}`);
}

// ─── Exit upsert helper ───────────────────────────────────────────────────────

async function upsertExit(id, fromLocationId, toLocationId, direction, extra = {}) {
  const data = { id, regionId: 100, fromLocationId, toLocationId, direction, isState: {}, ...extra };
  const existing = await db.exit.findUnique({ where: { regionId_id: { regionId: 100, id } } });
  if (existing) {
    await db.exit.update({ where: { regionId_id: { regionId: 100, id } }, data: { fromLocationId, toLocationId, direction, ...extra } });
  } else {
    await db.exit.create({ data });
  }
  console.log(`Exit 100:${id}: ${direction} from ${fromLocationId} to ${toLocationId}`);
}

// ─── Instance upsert helper ───────────────────────────────────────────────────

async function upsertInstance(id, regionId, templateId, ownerType, ownerId, state = {}, isState = {}, count = null) {
  const data = { id, regionId, templateId, ownerType, ownerId, state, isState, count, metadata: {} };
  const existing = await db.objectInstance.findFirst({ where: { regionId, id } });
  if (existing) {
    await db.objectInstance.update({ where: { pk: existing.pk }, data: { state, isState, count } });
  } else {
    await db.objectInstance.create({ data });
  }
  console.log(`Instance ${regionId}:${id} (template ${templateId})`);
}

// ─── Main seed ────────────────────────────────────────────────────────────────

async function main() {
  // ── Object Templates ──────────────────────────────────────────────────────
  await upsertTemplate({ id: 1001, name: 'stick', type: 'ITEM', weight: 1, regionId: null, baseSchema: { description: 'A dry wooden stick.' }, lootTable: [], aliases: ['stick', 'wood'] });
  await upsertTemplate({ id: 1002, name: 'cloth', type: 'ITEM', weight: 1, regionId: null, baseSchema: { description: 'A strip of rough cloth.' }, lootTable: [], aliases: ['cloth', 'rag'] });
  await upsertTemplate({ id: 1003, name: 'torch', type: 'CONSUMABLE', weight: 1, regionId: null, baseSchema: { description: 'A stick with cloth bound at one end, soaked in oil.' }, lootTable: [], aliases: ['torch'] });
  await upsertTemplate({ id: 1004, name: 'herb', type: 'ITEM', weight: 1, regionId: null, baseSchema: { description: 'A bundle of healing herbs.' }, lootTable: [], aliases: ['herb', 'herbs'] });
  await upsertTemplate({ id: 1005, name: 'healing_draught', type: 'CONSUMABLE', weight: 1, regionId: null, baseSchema: { description: 'A pale green potion that mends wounds.' }, lootTable: [], aliases: ['draught', 'potion'] });
  await upsertTemplate({ id: 1006, name: 'iron_ore', type: 'ITEM', weight: 3, regionId: null, baseSchema: { description: 'Rough chunks of iron ore.' }, lootTable: [], aliases: ['iron', 'ore'] });
  await upsertTemplate({ id: 1007, name: 'iron_dagger', type: 'WEAPON', weight: 2, regionId: null, baseSchema: { description: 'A crude but functional iron dagger.', damage: 5 }, lootTable: [], aliases: ['dagger'] });
  await upsertTemplate({ id: 1008, name: 'coin', type: 'COIN', weight: 0, regionId: null, baseSchema: { description: 'A standard copper coin.' }, lootTable: [], aliases: ['coin', 'coins'] });
  await upsertTemplate({ id: 2001, name: 'warren_goblin', type: 'MOB', weight: 0, regionId: 100, baseSchema: { description: 'A feral goblin lurking in the warren tunnels.', stats: { phy_for: { value: 22 } }, aiStates: { idle: 'patrol', combat: 'attack' }, stances: { default: 'aggressive' }, movementBehavior: 'wander' }, lootTable: [{ templateId: 1001, quantity: 1, dropChance: 60 }], aliases: ['goblin', 'warren goblin'] });
  await upsertTemplate({ id: 2002, name: 'alchemist_npc', type: 'MOB', weight: 0, regionId: 100, baseSchema: { description: 'The vale alchemist. She accepts herbs and brews draughts for adventurers.', aiStates: { idle: 'idle' }, stances: { default: 'neutral' }, movementBehavior: 'stationary', questGiver: [2] }, lootTable: [], aliases: ['alchemist', 'npc'] });
  await upsertTemplate({ id: 3001, name: 'forge_station', type: 'FIXTURE', weight: 999, regionId: null, baseSchema: { description: 'A stone forge with iron anvil and bellows.', stationType: 'FORGE' }, lootTable: [], aliases: ['forge', 'anvil'] });
  await upsertTemplate({ id: 3002, name: 'alchemy_station', type: 'FIXTURE', weight: 999, regionId: null, baseSchema: { description: 'A workbench lined with flasks and alembics.', stationType: 'ALCHEMY' }, lootTable: [], aliases: ['alchemy', 'bench', 'workbench'] });
  await upsertTemplate({ id: 3003, name: 'herb_node', type: 'FIXTURE', weight: 999, regionId: null, baseSchema: { description: 'A cluster of healing herbs growing wild.', resource: { yieldTemplateId: 1004, yieldCount: 2, respawnTicks: 15 } }, lootTable: [], aliases: ['herbs', 'plants', 'herb node'] });
  await upsertTemplate({ id: 3004, name: 'chest', type: 'CONTAINER', weight: 10, regionId: null, baseSchema: { description: 'A worn wooden chest.' }, lootTable: [], aliases: ['chest', 'box'] });
  await upsertTemplate({ id: 3005, name: 'lever', type: 'FIXTURE', weight: 999, regionId: null, baseSchema: { description: 'An iron lever set into the stone wall. It appears to control something.' }, lootTable: [], aliases: ['lever', 'handle'] });

  // ── Region 100 ────────────────────────────────────────────────────────────
  await upsertRegion();

  // ── Locations ─────────────────────────────────────────────────────────────
  await upsertLocation(1, 'Vale Gate', 'A wide stone archway marks the entrance to the Test Vale. Paths lead east to the market and south to the forge.', 'SAFE');
  await upsertLocation(2, 'Market Row', 'A cobbled row of stalls. A vendor hawk goods from the east stall. The alchemist\'s table sits to the west.', 'SAFE');
  await upsertLocation(3, 'Forge Yard', 'Hammers clang on iron. A stone forge dominates the south wall. Crates of raw ore sit nearby.', 'SAFE');
  await upsertLocation(4, 'Herb Hollow', 'A shaded dell thick with wild plants. Healing herbs cluster along the mossy banks.', 'OPEN');
  await upsertLocation(5, 'The Warren', 'A network of cramped tunnels carved by goblins. Danger echoes in every shadow.', 'DANGEROUS');
  await upsertLocation(6, 'Locked Vault', 'A stone chamber holding old relics. The dust suggests few have entered recently.', 'SAFE');

  // ── Exits (stable IDs: each direction gets a unique sequential id) ───────
  // Vale Gate ↔ Market Row (east/west)
  await upsertExit(1, 1, 2, 'east');
  await upsertExit(2, 2, 1, 'west');
  // Vale Gate ↔ Forge Yard (south/north)
  await upsertExit(3, 1, 3, 'south');
  await upsertExit(4, 3, 1, 'north');
  // Market Row ↔ Herb Hollow (north/south)
  await upsertExit(5, 2, 4, 'north');
  await upsertExit(6, 4, 2, 'south');
  // Herb Hollow ↔ The Warren (west/east)
  await upsertExit(7, 4, 5, 'west');
  await upsertExit(8, 5, 4, 'east');
  // Forge Yard ↔ Herb Hollow (east/west — completes the loop)
  await upsertExit(9, 3, 4, 'east');
  await upsertExit(10, 4, 3, 'west');
  // Vault entry (locked): Forge Yard → Locked Vault (down — unlocked by puzzle lever)
  await upsertExit(11, 3, 6, 'down', { isState: { locked: true } });
  await upsertExit(12, 6, 3, 'up');

  // ── Instances ─────────────────────────────────────────────────────────────
  // Market Row: vendor (instance 1) + alchemist NPC (instance 2)
  await upsertInstance(1, 100, 2001, 'LOCATION', '2', { vendor: { stock: [
    { templateId: 1001, price: 5, quantity: -1 },
    { templateId: 1002, price: 8, quantity: -1 },
    { templateId: 1006, price: 15, quantity: -1 },
  ], buyback: true, buybackRate: 0.5 } });
  await upsertInstance(2, 100, 2002, 'LOCATION', '2', { questGiver: [1, 2] });

  // Forge Yard: FORGE station (instance 3)
  await upsertInstance(3, 100, 3001, 'LOCATION', '3');

  // Herb Hollow: ALCHEMY station (instance 4) + 2 herb resource nodes (5, 6)
  await upsertInstance(4, 100, 3002, 'LOCATION', '4');
  await upsertInstance(5, 100, 3003, 'LOCATION', '4');
  await upsertInstance(6, 100, 3003, 'LOCATION', '4');

  // The Warren: 3 warren goblins (instances 7, 8, 9)
  await upsertInstance(7, 100, 2001, 'LOCATION', '5', { currentState: 'idle', hp: 20, maxHp: 20 });
  await upsertInstance(8, 100, 2001, 'LOCATION', '5', { currentState: 'idle', hp: 20, maxHp: 20 });
  await upsertInstance(9, 100, 2001, 'LOCATION', '5', { currentState: 'idle', hp: 20, maxHp: 20 });

  // Forge Yard: puzzle lever (instance 10) — controls the Vault exit (exit id 11)
  await upsertInstance(10, 100, 3005, 'LOCATION', '3', {}, { pulled: false });

  // ── DSL scripts ───────────────────────────────────────────────────────────

  // Lever script: on_use, flip isState.pulled and unlock exit 11 if pulled
  const leverScriptBody = {
    rules: [
      {
        trigger: 'on_use',
        triggerArgs: [],
        conditions: [{ fn: 'is_state', args: ['pulled', 'false'] }],
        actions: [
          { fn: 'set_state', args: ['pulled', 'true'] },
          { fn: 'say', args: ['The lever clunks into place. You hear a distant grinding sound.'] },
        ],
      },
      {
        trigger: 'on_use',
        triggerArgs: [],
        conditions: [{ fn: 'is_state', args: ['pulled', 'true'] }],
        actions: [
          { fn: 'say', args: ['The lever is already pulled.'] },
        ],
      },
    ],
    subroutines: {},
  };

  // Location script for Forge Yard: watches for the lever being pulled; unlocks exit 11
  const forgeYardScriptBody = {
    rules: [
      {
        trigger: 'on_use',
        triggerArgs: [],
        conditions: [{ fn: 'is_state', args: ['pulled', 'true'] }],
        actions: [
          { fn: 'say', args: ['A stone door beneath the forge yard grinds open.'] },
          { fn: 'unlock', args: [] },
        ],
      },
    ],
    subroutines: {},
  };

  // Market Row on_tick story script: announces day/night cycle
  const marketScriptBody = {
    rules: [
      {
        trigger: 'on_tick',
        triggerArgs: [],
        conditions: [],
        actions: [
          { fn: 'say', args: ['The market hum continues under the vale sky.'] },
        ],
      },
    ],
    subroutines: {},
  };

  // Attach scripts to lever instance and Forge Yard location
  // First check if scripts already exist to remain idempotent

  // Lever script → objectTemplate 3005 (lever)
  const leverTmpl = await db.objectTemplate.findUnique({ where: { id: 3005 } });
  if (!leverTmpl?.scriptId) {
    const leverScriptId = await createScript(leverScriptBody, { attachedToType: 'OBJECT_TEMPLATE', attachedToId: '3005' });
    await db.objectTemplate.update({ where: { id: 3005 }, data: { scriptId: leverScriptId } });
    console.log(`Lever script attached (id ${leverScriptId})`);
  } else {
    await db.script.update({ where: { id: leverTmpl.scriptId }, data: { body: leverScriptBody } });
    console.log(`Lever script updated (id ${leverTmpl.scriptId})`);
  }

  // Forge Yard location script
  const forgeYardLoc = await db.location.findUnique({ where: { regionId_id: { regionId: 100, id: 3 } } });
  if (!forgeYardLoc?.scriptId) {
    const forgeScriptId = await createScript(forgeYardScriptBody, { attachedToType: 'LOCATION', attachedToId: '100:3' });
    await db.location.update({ where: { regionId_id: { regionId: 100, id: 3 } }, data: { scriptId: forgeScriptId } });
    console.log(`Forge Yard script attached (id ${forgeScriptId})`);
  } else {
    await db.script.update({ where: { id: forgeYardLoc.scriptId }, data: { body: forgeYardScriptBody } });
    console.log(`Forge Yard script updated (id ${forgeYardLoc.scriptId})`);
  }

  // Market Row on_tick script
  const marketLoc = await db.location.findUnique({ where: { regionId_id: { regionId: 100, id: 2 } } });
  if (!marketLoc?.scriptId) {
    const marketScriptId = await createScript(marketScriptBody, { attachedToType: 'LOCATION', attachedToId: '100:2' });
    await db.location.update({ where: { regionId_id: { regionId: 100, id: 2 } }, data: { scriptId: marketScriptId } });
    console.log(`Market Row script attached (id ${marketScriptId})`);
  } else {
    await db.script.update({ where: { id: marketLoc.scriptId }, data: { body: marketScriptBody } });
    console.log(`Market Row script updated (id ${marketLoc.scriptId})`);
  }

  console.log('\nTest Vale seed complete. Region 100 ready.');
  console.log('Start point: location 100:1 (Vale Gate)');
  console.log('Goblin kill quest targets: instances 7, 8, 9 (template 2001)');
  console.log('Alchemist NPC: instance 2 (template 2002) — for deliver objectives');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
