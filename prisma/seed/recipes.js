// Seed starter recipes used by the Test Vale (Task 9).
// Run: node prisma/seed/recipes.js
// Idempotent: upserts by name.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

const recipes = [
  {
    name: 'torch',
    description: 'Bind a cloth strip to a stick to make a simple torch.',
    // inputs: 1 stick (template 1001) + 1 cloth (template 1002)
    inputs:  [{ templateId: 1001, quantity: 1 }, { templateId: 1002, quantity: 1 }],
    outputs: [{ templateId: 1003, quantity: 1 }], // torch
    skillId: null,
    stationType: null,
    regionScoped: false,
  },
  {
    name: 'healing_draught',
    description: 'Distil two healing herbs into a restorative draught.',
    inputs:  [{ templateId: 1004, quantity: 2 }], // herb
    outputs: [{ templateId: 1005, quantity: 1 }], // healing_draught
    skillId: 1, // herbalism — seeded by skills.js
    stationType: 'ALCHEMY',
    regionScoped: false,
  },
  {
    name: 'iron_dagger',
    description: 'Forge two iron ore chunks into a short iron dagger.',
    inputs:  [{ templateId: 1006, quantity: 2 }], // iron_ore
    outputs: [{ templateId: 1007, quantity: 1 }], // iron_dagger
    skillId: null,
    stationType: 'FORGE',
    regionScoped: false,
  },
];

async function main() {
  for (const r of recipes) {
    await db.recipe.upsert({
      where: { name: r.name },
      update: r,
      create: r,
    });
    console.log(`Upserted recipe: ${r.name}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
