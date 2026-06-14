// Seed starter quests for the Test Vale (Task 9).
// Run: node prisma/seed/quests.js
// Idempotent: upserts by name.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

const quests = [
  {
    name: 'Culling the Warren',
    description: 'The warren beneath the vale has grown dangerous. Thin the goblin population.',
    objectives: [
      { id: 'kill_goblins', type: 'kill', target: '2001', count: 3, desc: 'Slay 3 warren goblins' },
    ],
    rewards: { coins: 50, items: [], skillIds: [] },
    prerequisites: [],
    regionScoped: false,
    repeatable: false,
  },
  {
    name: "The Alchemist's Errand",
    description: 'The market alchemist needs a healing draught. Gather herbs and brew one for them.',
    objectives: [
      { id: 'collect_herb', type: 'collect', target: '1004', count: 2, desc: 'Collect 2 healing herbs' },
      { id: 'deliver_draught', type: 'deliver', target: '2002:1005', count: 1, desc: 'Deliver 1 healing draught to the alchemist' },
    ],
    rewards: { coins: 30, items: [{ templateId: 1005, quantity: 1 }], skillIds: [1] },
    prerequisites: [],
    regionScoped: false,
    repeatable: true,
  },
];

async function main() {
  for (const q of quests) {
    await db.quest.upsert({
      where: { name: q.name },
      update: q,
      create: q,
    });
    console.log(`Upserted quest: ${q.name}`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
