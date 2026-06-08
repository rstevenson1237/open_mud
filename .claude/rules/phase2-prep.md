# Phase 2 Preparation — Decisions & Starting Conditions

This file documents the open decisions that must be resolved before
Phase 2 implementation begins, and the conventions Phase 2 must follow.

## What Phase 2 Is

Phase 2 builds entirely on top of Phase 1 without modifying Phase 1 internals.
Every Phase 2 addition is either:
- A `registerCommand()` call in a new file under `server/interface/`
- A Prisma schema addition (new field or table) via `npm run db:migrate`
- A `.add()` call extending VALID_TRIGGERS / VALID_CONDITION_FNS / VALID_ACTION_FNS
- A new entry in the world-level condition or skill definition tables
- A new Phase 2 engine module (e.g. `server/engine/combat.js`) that the state machine calls

Phase 2 never:
- Modifies `server/engine/permissions.js`
- Modifies `server/interface/commands.js` internals
- Rewrites the VALID_ Sets in `server/engine/dsl/parser.js`
- Adds game logic outside the state machine / command handler pattern
- Hardcodes condition names in engine logic

## Open Decisions (resolve before coding each system)

### Stats
Phase 1 stores stats as generic JSON on Avatar.
Phase 2 must define the named stat set before any command touches characters.
Candidate set: body, mind, reflex, presence (4 stats, genre-flexible).
Regions alias these for flavor in their config.
Decision needed before: character creation, combat, skill resolution.

### Wound Severity
Agreed: named tiers not raw integers.
Candidate tiers: unharmed → wounded → critical → dying (each a discrete condition).
Each tier is a Condition record in the world condition library.
Decision needed before: combat implementation.

### Skill Cap
Agreed: world hard cap with region able to set lower cap per skill.
Candidate world hard cap: 80 (leaving 20% failure rate at mastery, fitting 0–99 model).
Decision needed before: skill progression implementation.

### PvP Consent
Candidate: zone entry implies consent in open/dangerous zones.
Optional per-character pacifist flag to opt out regardless of zone.
Decision needed before: combat implementation.

### Flee Mechanic
Candidate: contested roll. Attacker rolls combat skill vs fleeing character rolls reflex.
Fleeing character wins ties. Success exits combat and executes go to random available exit.
Decision needed before: combat implementation.

## Phase 2 Task Order (dependency sequence)

Do not start a task until its dependencies are complete and verified.

1. Stat schema — define named stats, seed defaults on Avatar
2. Character creation flow — name, starting region, stat defaults, empty skill set
3. Condition library seed — wound tiers, survival conditions, mechanical conditions
4. Core navigation commands — look, go, exits (depends on: stat schema)
5. Inventory commands — get, drop, give, examine, inventory (depends on: weight fields)
6. Communication commands — say, whisper, shout, tell, message (no stat dependency)
7. Skill system — definitions, use-based progression, proficiency checks
8. Survival system — wound/stress/hunger/rest tick decrements, recovery paths
9. Combat system — attack, stances, zone enforcement, death handling
10. Builder commands — create location/exit/object, describe, place, link
11. Crafting commands — recipe definitions, craft command
12. Trade stub — give command already handles transfer; escrow for Phase 2 trade sessions

## Phase 2 File Conventions

New command files: `server/interface/cmd_*.js`
  e.g. `cmd_navigation.js`, `cmd_inventory.js`, `cmd_combat.js`
Each file exports a `register()` function called from `server/index.js` at startup.

New engine modules: `server/engine/*.js`
  e.g. `server/engine/combat.js`, `server/engine/survival.js`

New seed data scripts: `prisma/seed/`
  e.g. `prisma/seed/conditions.js`, `prisma/seed/skills.js`
Run with: `node prisma/seed/conditions.js`

## Testing Each Phase 2 Task

Every task must include a verify step before committing.
Minimum verification: connect as root, run the new command, confirm expected output.
For state changes: confirm Redis hot state and Postgres flush both reflect the change.
For combat/skills: confirm roll outcomes match the resolve() function's expected tiers.
