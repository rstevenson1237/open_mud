// Seed the world-level Condition library for Phase 2.
// Run with: node prisma/seed/conditions.js
// Idempotent — upsert by name.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// Duration sentinel: null = permanent
const PERM = null;

const CONDITIONS = [
  // ── Wound chain ──────────────────────────────────────────────────────────
  { name: 'wounded_1',  type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res', modifier: -5,  defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'wounded_2',  type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res', modifier: -10, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'wounded_3',  type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res', modifier: -15, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'dying',      type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: 10, overridesInput: true,  overrideAction: null },

  // ── Sanity chain ─────────────────────────────────────────────────────────
  { name: 'shaken_1',   type: 'MECHANICAL', affectedStat: 'men_for,men_pre,men_res', modifier: -5,  defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'shaken_2',   type: 'MECHANICAL', affectedStat: 'men_for,men_pre,men_res', modifier: -10, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'shaken_3',   type: 'MECHANICAL', affectedStat: 'men_for,men_pre,men_res', modifier: -15, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'broken',     type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: 10, overridesInput: false, overrideAction: null },

  // ── Break states ─────────────────────────────────────────────────────────
  { name: 'confusion',     type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: 10, overridesInput: true,  overrideAction: 'random_move()' },
  { name: 'flee_state',    type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: 10, overridesInput: true,  overrideAction: 'action_run()' },
  { name: 'panic',         type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res,men_for,men_pre,men_res,soc_for,soc_pre,soc_res', modifier: -10, defaultDurationTicks: 10, overridesInput: false, overrideAction: null },
  { name: 'comatose',      type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: true,  overrideAction: null },
  { name: 'mental_break',  type: 'MECHANICAL', affectedStat: 'men_for,men_pre,men_res', modifier: -20, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },

  // ── Stress ───────────────────────────────────────────────────────────────
  { name: 'strained',      type: 'GAME',       affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'overwhelmed',   type: 'MECHANICAL', affectedStat: 'men_for,men_pre,men_res', modifier: -5, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },

  // ── Equipment / combat ───────────────────────────────────────────────────
  { name: 'armor_broken',  type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'in_combat',     type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'dead',          type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: true,  overrideAction: null },

  // ── Hunger / rest ─────────────────────────────────────────────────────────
  { name: 'hungry',        type: 'GAME',       affectedStat: 'phy_res',           modifier: -2, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'starving',      type: 'MECHANICAL', affectedStat: 'phy_for,phy_res',   modifier: -5, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'famished',      type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res', modifier: -10, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'tired',         type: 'GAME',       affectedStat: 'men_pre',           modifier: -2, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'exhausted',     type: 'MECHANICAL', affectedStat: 'men_for,men_pre',   modifier: -5, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
  { name: 'collapsed',     type: 'MECHANICAL', affectedStat: 'phy_for,phy_pre,phy_res,men_for,men_pre,men_res', modifier: -10, defaultDurationTicks: PERM, overridesInput: true, overrideAction: null },

  // ── Carry weight ─────────────────────────────────────────────────────────
  { name: 'encumbered',    type: 'MECHANICAL', affectedStat: 'phy_pre',           modifier: -5, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },

  // ── Communication ────────────────────────────────────────────────────────
  { name: 'silenced',      type: 'MECHANICAL', affectedStat: null, modifier: 0, defaultDurationTicks: PERM, overridesInput: false, overrideAction: null },
];

async function seed() {
  let created = 0, updated = 0;
  for (const cond of CONDITIONS) {
    const existing = await db.condition.findUnique({ where: { name: cond.name } });
    if (existing) {
      await db.condition.update({ where: { name: cond.name }, data: cond });
      updated++;
    } else {
      await db.condition.create({ data: cond });
      created++;
    }
  }
  console.log(`Conditions seeded: ${created} created, ${updated} updated`);
  const all = await db.condition.findMany({ orderBy: { id: 'asc' } });
  console.log(`Total conditions in DB: ${all.length}`);
}

seed()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
