// Seed WorldState.config with Phase 2 defaults.
// Run with: node prisma/seed/world_config.js
// Idempotent — merges into existing config without overwriting other keys.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const DEFAULTS = {
  majorBudget: 30,
  minorBudgetPerMajor: 20,
};

async function seed() {
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const existing = world?.config ?? {};
  const merged = { ...existing, ...DEFAULTS };

  await db.worldState.upsert({
    where: { id: 1 },
    create: { id: 1, config: merged },
    update: { config: merged },
  });

  console.log('WorldState.config seeded:', merged);
}

seed()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
