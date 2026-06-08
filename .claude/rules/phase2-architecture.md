# Phase 2 Architecture — Hard Constraints & Resolved Decisions

This document **supersedes `.claude/rules/phase2-prep.md`** — delete that file.
Where this document or the Phase 2 Implementation Guide (`phase2_impl.md`) disagrees
with any earlier note, these two win. The candidate decisions recorded in
`phase2-prep.md` (4-stat body/mind/reflex/presence model, named wound tiers,
use-based skill progression, world skill cap 80) are **withdrawn** and replaced
by the authoritative models below.

These decisions are final for Phase 2. Build to them; do not reinterpret them.

---

## What Phase 2 Is

Phase 2 builds game systems on top of the Phase 1 engine. Every addition is one of:
- A `registerCommand()` call in a new `server/interface/cmd_*.js` file.
- A Prisma schema addition (new field or table) via `npm run db:migrate`.
- A `.add()` extension of `VALID_TRIGGERS` / `VALID_CONDITION_FNS` / `VALID_ACTION_FNS`.
- A new world-level condition or skill definition (seed script under `prisma/seed/`).
- A new Phase 2 engine module under `server/engine/` invoked by the tick pipeline.
- A maintenance task registered via `registerMaintenanceTask()` (see below).

Phase 1 is otherwise immutable. The single exception is the explicitly enumerated
list of sanctioned edits below — nothing else in Phase 1 is touched.

---

## Sanctioned Phase 1 Edits

Phase 2 may modify ONLY the following files, and only in the ways described. This
is the complete list; any change outside it is out of scope.

1. **`server/tick/engine.js`** — replace the single-pass `drain → arbitrate-all →
   process-all` loop with the sequential phase pipeline (below). This is the one
   structural rework Phase 2 requires.
2. **`server/tick/queue.js`** — `enqueueAction(action)` routes to per-phase queues
   (`action:queue:{phase}`) by `action.phase`.
3. **`server/engine/conditions.js`** — two bounded fixes only: (a) correct the
   `emitEvent` argument order in `tickConditions`; (b) make `tickConditions`
   iterate `instance:*` as well as `avatar:*`. No signature changes to
   `applyCondition` / `removeCondition` / `hasCondition` / `getStatModifier`.
4. **`server/db/sync.js`** — `flushDirtyState` serializes through a DB-column
   whitelist before `update`, and handles null-region instance keys.
5. **`server/engine/statemachine.js`** — `_loadEntity` / `_saveEntity` resolve the
   script's *attached target* (object / exit / location / instance), not only the
   actor avatar; action execution substitutes `$` / `#` / `@` sigil args from
   context before dispatch.
6. **`server/ws/server.js`** — fill the designated `POST /upload/script` stub only.
7. **`server/index.js`** — append Phase 2 `register()` calls and
   `registerMaintenanceTask()` registrations after `registerBuiltins()`.

Untouched, no exceptions: `permissions.js`, `commands.js` internals, `output.js`,
`resolver.js`, and the bodies of the `VALID_` Sets (extend via `.add()` only).

---

## The Tick Model

- 6-second authoritative tick, worker thread isolated from I/O (unchanged).
- **Command handlers run between ticks.** On input, a handler validates,
  permission-checks, resolves the target reference, then either:
  - *World-changing command:* enqueues an action into its phase queue and returns
    a short acknowledgement string ("You ready your blade.").
  - *Readout command* (`look`, `exits`, `i`/`inventory`, `examine`/`x`,
    `coins`/`balance`, `view-script`, `config` display): executes inline against
    hot-state and returns immediately. Never enqueues.
- **On tick fire, phases process in order, sequentially, against Redis hot-state.**
  Effects from an earlier phase are visible to later phases *within the same tick*
  (a player who moves in Movement hears a Communication message in the new room).
- Redis hot-state mutates as phases resolve. The Postgres flush (`flushDirtyState`)
  is the durability commit — run every `dbFlushIntervalTicks` and at the end of the
  Maintenance phase. Players see post-tick hot-state.

The roll itself is drawn at **resolution time** (during the phase), not at enqueue.
The enqueued action carries everything needed to compute the target number and roll
at resolution.

---

## Phase Pipeline

Processing order within every tick:

1. **Movement** — `go`, `travel`, `teleport`, `run`/`flee`.
2. **Communication** — `say`, `whisper`, `shout`, `alert`, `tell`, `message`.
   Ungated; never blocked by combat.
3. **Action** — `attack`, `get`/`drop`/`give`, `put`/`take`, `use`, `open`/`close`,
   `wear`/`remove`, `buy`/`sell`, trade operations.
4. **Response** — events emitted by phases 1–3 (`on_wound`, `on_kill`, `on_flee`,
   `on_give`, `on_enter`, …). Drained and run **within the same tick**, so a
   phase-3 attack resolves its `on_wound`/`on_kill` here, this tick.
5. **Maintenance** — programmable (see below). Condition tick + expiry (avatars
   *and* instances), survival, `on_tick` story/mob scripts, day/night clocks,
   future depletion. Flush follows.

Each enqueued action object:
```js
{
  phase: 3,                      // 1–5; default 3 if omitted
  category: 'combat',            // combat|movement|inventory|communication|other
  resourceKey: 'instance:7:42',  // contention key; null = uncontested
  trigger: 'on_melee',           // state-machine trigger to fire (if any)
  sessionToken,                  // origin session (for output + PRNG)
  context: { actorAvatarId, ... } // everything the resolver/handler needs
}
```
`enqueueAction` routes by `phase` to `action:queue:{phase}`. The engine drains
queues 1→5 in order each tick.

---

## Action Resolution Order (within a phase)

A **contention group** is the set of actions in the same phase sharing a
`resourceKey`. Actions in different groups do not interact; their relative order is
FIFO and irrelevant.

**Every action draws a roll**, including uncontested and no-skill actions. `resolve()`
already returns a `roll` for ungated calls (pass `null` target); that roll is the
ordering die. Two players grabbing the same item in one tick are decided by roll, not
by arrival order.

Within a group:

1. Compute each action's target against the **start-of-phase snapshot** (or `null`
   for ungated), then draw a roll for **every** action via `resolve()` /
   `resolveOpposed()`.
2. Set aside **gated failures** (roll ≥ target). They claim nothing.
3. Apply all remaining actions — gated successes and ungated alike — in
   **ascending-roll order** (smallest roll resolves first; for a gated action a smaller
   roll is also the stronger result). Each application mutates hot-state; the next
   action sees it.
4. **No re-rolling.** If an earlier effect invalidates a later action's premise (item
   taken, target already dying), that action degrades to a contextual no-op at apply
   time ("The sword is already gone.") — it does not re-roll.
5. **Failures** apply last, individually: emit each actor's failure outcome and queue
   any failure-triggered events to the Response phase. Failures never mutate the
   contested resource.

An ungated roll *orders* the action; it does not give it a chance to fail (no target =
always proceeds). For an uncontested action (its own singleton group) the roll is drawn
but inert.

**Tiebreak chain** for equal position: ascending roll → category priority
(`combat 4 > movement 3 > inventory 2 > communication 1`, retained *only* as the
same-roll tiebreak) → enqueue order (FIFO). No `Math.random` in arbitration —
identical inputs resolve identically. (Category priority can be dropped later if it
proves inert; FIFO then breaks equal-roll ties.)

`resolveOpposed` keeps "tie → defender wins" for opposed rolls specifically; the
FIFO rule governs same-side ordering only.

---

## Maintenance Phase & Registration Interface

The Maintenance phase runs a registry of tick tasks. New depletion/upkeep systems
register instead of editing the engine.

```js
// server/tick/maintenance.js (new Phase 2 module)
const tasks = [];
export function registerMaintenanceTask(name, handler) { tasks.push({ name, handler }); }
export async function runMaintenance(currentTick, emitEvent) {
  for (const t of tasks) {
    try { await t.handler(currentTick, emitEvent); }
    catch (e) { logger.error('MAINTENANCE', 'task failed', { task: t.name, error: e.message }); }
  }
}
```

`engine.js` calls `runMaintenance(tickCount, emit)` as phase 5, after the Response
phase and before `flushDirtyState`. Registration order is execution order.

Phase 2 registers (in `index.js`, after `registerBuiltins()`):
- `conditions` — `tickConditions` (avatars + instances) for expiry/duration.
- `survival` — stress, wound-chain integrity, sanity-chain integrity.
- `world-scripts` — emit `on_tick` to region/location/mob scripts (drives day/night
  via region clock, mob AI, hunger/rest depletion authored in story scripts).

---

## Stat Model (authoritative)

Nine stats on `avatar.stats` JSON, each `{ "value": N, "metadata": {} }`:
`phy_for phy_pre phy_res  men_for men_pre men_res  soc_for soc_pre soc_res`.

- Baseline 20. Point-buy is allocation **above** baseline.
- World budgets in `WorldState.config`: `majorBudget: 30` (across Physical/Mental/
  Social), `minorBudgetPerMajor: 20` (across Force/Precision/Resistance per major).
- Stat contribution to a roll target: `Math.min(value, 40)`.
- Stats do not advance through play. Modification only via condition `modifier` or
  spell.

**Roll target composition** (passed to `resolve`):
`target = min(statValue, 40) + skillRollContribution(0–20) + conditionModifier(−10..+10)`,
hard-capped at **70**. `resolve()` independently clamps to 1–99. Ungated actions
pass `null`.

## Skill Model (authoritative)

`SkillDefinition` is world-level (table in `phase2_impl.md` TASK 2). Skills have a
**fixed** `rollContribution` (0–20); they do **not** progress. Acquisition is by
`grant_skill` action or `grant @avatar {skillId}` command, gated on prerequisites
and (if `regionScoped`) region skill list. Revocation cascades to dependents.
Spell skills (`attachedToObject: true`) attach to an instance's `state.skills`, not
the avatar, and are lost with the object.

## Wound / Sanity Model (authoritative)

Integer tracks, not free-form. `avatar.wounds` and `avatar.sanity` are integers
(0..`woundMax`/`sanityMax`, default 3). The Maintenance survival task enforces the
condition chain each tick:
- wounds 1 → `wounded_1`; 2 → `+wounded_2`; 3 (=woundMax) → `+wounded_3` + `dying`.
- sanity 1 → `shaken_1`; 2 → `+shaken_2`; 3 (=sanityMax) → `+shaken_3` + break state.
Stress is a separate integer clamped 1–20; at 20 apply `overwhelmed` + `panic`.

---

## Hot-State vs Persisted State

Redis hot-state may carry transient fields the DB has no column for (e.g.
`locationName`, `zoneType`, computed combat scratch). `flushDirtyState` must
serialize through a **DB-column whitelist** so these never reach `db.*.update`.
Persistent state lives in real columns (`stats`, `skills`, `wounds`, `sanity`,
`stress`, `activeConditions`, `isState`, `state`, `count`, `currentLocationId`,
`visitedRegions`, `carryCapacity`, `encumberedThreshold`, `metadata`). Transient
fields are recomputed on load, never flushed.

---

## Conventions

- Command files: `server/interface/cmd_*.js`, each exports `register()`.
- Engine modules: `server/engine/*.js`. Maintenance tasks register in `index.js`.
- Seed scripts: `prisma/seed/*.js`, run with `node prisma/seed/<file>.js`.
- After any schema change: `npm run db:generate` then `npm run db:migrate`.
- Single developer: commit to main after each task's **Verify** passes. Never commit
  before Verify passes.
- No hardcoded condition names in engine logic — read from the condition library.
