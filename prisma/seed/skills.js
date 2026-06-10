// Seed starter SkillDefinitions.
// Run with: node prisma/seed/skills.js
// Idempotent — upsert by name.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// Minor-level skills (specific stat, e.g. 'phy_for') → rollContribution 15–20
// Major-level skills (broad major, e.g. 'Physical') → rollContribution 10–14
const STARTER_SKILLS = [
  {
    name: 'brawling',
    stat: 'phy_for',
    rollContribution: 16,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: ['attack_target'],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    name: 'athletics',
    stat: 'phy_pre',
    rollContribution: 15,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: ['action_run'],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    name: 'endurance',
    stat: 'phy_res',
    rollContribution: 15,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: [],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    name: 'investigation',
    stat: 'men_pre',
    rollContribution: 15,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: [],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    name: 'resolve',
    stat: 'men_res',
    rollContribution: 15,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: [],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    // Example spell skill — lives on instance.state.skills, not avatar
    name: 'flame_bolt',
    stat: 'men_for',
    rollContribution: 18,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: ['attack_target'],
    attachedToObject: true,
    regionScoped: false,
  },
  {
    // Broad physical skill — applies to any phy_* roll, lower bonus
    name: 'physical_aptitude',
    stat: 'Physical',
    rollContribution: 12,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: [],
    attachedToObject: false,
    regionScoped: false,
  },
  {
    // Broad social skill — applies to any soc_* roll, lower bonus
    name: 'social_grace',
    stat: 'Social',
    rollContribution: 11,
    autoSucceedSimple: false,
    prerequisites: [],
    unlocksActions: [],
    attachedToObject: false,
    regionScoped: false,
  },
];

async function seed() {
  let created = 0, updated = 0;
  for (const skill of STARTER_SKILLS) {
    const existing = await db.skillDefinition.findUnique({ where: { name: skill.name } });
    if (existing) {
      await db.skillDefinition.update({ where: { name: skill.name }, data: skill });
      updated++;
    } else {
      await db.skillDefinition.create({ data: skill });
      created++;
    }
  }
  const all = await db.skillDefinition.findMany({ orderBy: { id: 'asc' } });
  console.log(`Skills seeded: ${created} created, ${updated} updated`);
  console.log('Current skills:', all.map(s => `${s.id}:${s.name}(+${s.rollContribution})`).join(', '));
}

seed()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
