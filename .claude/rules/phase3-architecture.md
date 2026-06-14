# Phase 3 Architecture — Hard Constraints & Resolved Decisions

This document is the binding rules doc for Phase 3. Where it and
`phase2-architecture.md` disagree, this document wins.

---

## Registration-Site Rule (critical)

Two registration surfaces exist; they are **never** mixed:

- **`server/index.js`** (main thread) — registers **command modules** only.
  `registerCommand()` calls belong here, via `register()` exports of `cmd_*.js`.
- **`server/tick/engine.js` `init()`** (worker thread) — registers **system
  handlers** (`registerSystemHandler`) and **maintenance tasks**
  (`registerMaintenanceTask`). The worker is the only thread that runs the tick.
  Phase 3 system handlers (crafting, trade, quest hook) and maintenance tasks
  (tradeReaper, resourceRespawn) register here.

`registerSystemHandler` and `registerMaintenanceTask` must NEVER appear in `index.js`.

---

## Sanctioned Phase 3 Edits to Existing Files

This is the complete list. No other Phase 1/2 files are touched.

1. **`server/tick/engine.js`** — register Phase 3 system handlers + maintenance tasks
   in `init()`; add `questHook` call in the Response-phase drain loop after primary
   handler dispatch.
2. **`server/engine/statemachine.js`** — per-script target context (Task 0.2);
   real `create_instance`/`destroy_instance` (Task 3); `_saveStructural`
   implementation (Task 0.3).
3. **`server/engine/dsl/parser.js`** — `.add()` new triggers/conditions/actions only.
4. **`server/db/sync.js`** — add `'quests'` to `AVATAR_COLS`.
5. **`server/interface/cmd_inventory.js`** — remove the duplicate `trade` registration.
6. **`server/index.js`** — append new `register()` calls for Phase 3 command modules.
7. **`CLAUDE.md`**, **`.claude/rules/engine.md`**, **`.claude/rules/schema.md`** —
   documentation updates (Task 12).

---

## Data Models

### Recipe (Prisma table)
```js
{
  id:           Int (autoincrement PK),
  name:         String (unique),
  description:  String,
  inputs:       Json   // [{ templateId, quantity }]
  outputs:      Json   // [{ templateId, quantity }]
  skillId:      Int?   // optional required SkillDefinition id
  stationType:  String? // optional required ObjectType/tag at location
  regionScoped: Boolean
  metadata:     Json?
}
```

### Quest (Prisma table)
```js
{
  id:            Int (autoincrement PK),
  name:          String (unique),
  description:   String,
  objectives:    Json  // [{ id, type: 'kill'|'collect'|'visit'|'deliver', target, count, desc }]
  rewards:       Json  // { coins?: N, items?: [{templateId, quantity}], skillIds?: [N] }
  prerequisites: Json  // quest ids that must be turned_in first
  regionScoped:  Boolean,
  repeatable:    Boolean,
  metadata:      Json?
}
```

### avatar.quests (JSON column on Avatar)
```js
{
  "<questId>": {
    status:     'active' | 'complete' | 'turned_in',
    objectives: { "<objId>": { progress: N, done: bool } },
    startedAt:  <tick>
  }
}
```
`quests` is in the `AVATAR_COLS` flush whitelist.

### Escrow (Redis key)
Key: `trade:<sortedAvatarPair>` (e.g. `trade:12-17` where 12 < 17)
```js
{
  a: { avatarId: N, sessionToken: "...", items: [instanceId...], coins: N, confirmed: false },
  b: { ... },
  openedTick: N,
  regionId: N,
  locationId: N
}
```

---

## Instance-ID Allocation Rule

All **tick-time spawns** (crafting outputs, loot drops, quest rewards, resource
respawns) MUST use `allocateInstanceId(regionId)` from
`server/engine/idAllocator.js`. This Redis INCR counter is lazily seeded from
the DB max on first use. Builder commands that run between ticks may use the
existing `findFirst({ orderBy: { id: 'desc' } })` pattern for single human-paced
creates, but prefer `allocateInstanceId` to avoid interleaving.

Redis counter key convention: `world:nextInstanceId:{regionId}` (or
`world:nextInstanceId:null` for world-scoped instances).

---

## Reactive Quest-Hook Contract

`questHook(eventName, context, tick, emit, sendOutput)` is imported into
`engine.js` and called **once per drained Response event**, AFTER the primary
handler dispatch. It must never be added to `SYSTEM_HANDLERS` (which is a
single-value map). It is a no-op stub until Task 6 implements it.

```js
// inside the Response while-loop, AFTER primary handler dispatch:
await questHook(ev.eventName, evContext, tickCount, emit, sendOutput);
```

---

## New VALID_* Vocabulary Added in Phase 3

### Triggers (`.add()` in `parser.js`)
- `on_craft`       — fires after a successful craft; context includes `recipeId`, `outputs`
- `on_quest_accept`    — fires when an avatar accepts a quest
- `on_quest_complete`  — fires when a quest turns in; context includes `questId`
- `on_harvest`     — fires when a resource node is harvested (Task 8)
- `on_respawn`     — fires when a resource node respawns (Task 8)

### Condition Functions (`.add()` in `parser.js`)
- `has_quest(questId, status)` — true if avatar.quests[questId].status === status

### Action Functions (`.add()` in `parser.js`)
- `grant_quest(avatarId, questId)`   — starts quest progress on an avatar
- `complete_quest(avatarId, questId)` — dispatches rewards; sets turned_in

---

## Crafting Design Decisions

- **Failure is forgiving by default**: a gated crafting roll failure consumes NO
  inputs. Inputs are only consumed on success (or ungated). To enable lossy
  failure set `recipe.metadata.consumeOnFail = true`.
- **Output overflow**: if crafted outputs would exceed the avatar's carry capacity,
  the overflow is dropped to the avatar's current location (not lost). A warning
  message is sent.

## Quest Design Decisions

- **`collect` objective semantics**: tracks *currently held* quantity, not
  historical acquisition. Dropping an item un-satisfies the objective until
  re-held. Use `deliver` for consume-on-turn-in flows.
- **Turn-in prerequisites**: all listed prerequisite quest IDs must be
  `turned_in` before a quest can be accepted.
- **Repeatable quests**: on turn-in, the quest entry is deleted from `avatar.quests`
  (not set to `turned_in`), allowing re-accept.

---

## Phase 3 Complete System List

Systems added by Phase 3 (in implementation order):
1. **Hardening** — per-script target context, structural script save,
   real create/destroy_instance, single trade command, reactive quest hook
2. **idAllocator** — `server/engine/idAllocator.js`
3. **Trade escrow** — `server/engine/trade.js`, extending `cmd_economy.js`
4. **Crafting** — `server/engine/crafting.js`, `server/interface/cmd_crafting.js`
5. **Quests** — `server/engine/quests.js`, extending builder commands
6. **Resource nodes** — `server/engine/resources.js` (optional, Task 8)
7. **Seed content** — `prisma/seed/recipes.js`, `prisma/seed/quests.js`,
   `prisma/seed/test_vale.js`
8. **Docs** — `docs/phase3_walkthrough.md`, `docs/phase3_playtest_checklist.md`
