# Phase 2 Implementation Guide
## MUD Engine — Game Systems
### Target: Agentic AI Developer

---

## OVERVIEW & CONSTRAINTS

This guide implements Phase 2 game systems on top of the Phase 1 engine. Read
`.claude/rules/phase2-architecture.md` **first** — it is the binding rules doc and
resolves the stat/skill/wound models, the tick pipeline, the action resolution
order, and the exact list of sanctioned Phase 1 edits. This guide assumes those
decisions.

**Hard rules (from the architecture doc):**
- Phase 1 is immutable except the seven enumerated sanctioned edits.
- Command handlers run *between ticks*; world-changing commands enqueue into a phase
  queue and return an ack, readouts answer inline.
- Phases process sequentially against Redis hot-state; the roll is drawn at
  resolution time, not at enqueue.
- Within a phase, contention groups resolve by ascending roll, then ungated FIFO,
  then failures; no re-rolling.
- After any schema change: `npm run db:generate` then `npm run db:migrate`.
- Every task ends with a **Verify** step. Do not commit until Verify passes.

**Implementation sequence** (each depends on the previous):

0. Engine rework (tick pipeline, queue, maintenance, sanctioned fixes)
1. Stat matrix
2. Skill definitions
3. Condition library seed
4. Region config additions
5. Character creation
6. Navigation commands
7. Communication commands
8. Inventory commands
9. Survival tick
10. Combat
11. Sanity / horror pathway
12. Mob behavior
13. Builder commands
14. File upload endpoint
15. Economy stub

Then update `CLAUDE.md`.

---

## TASK 0 — Engine Rework (Foundation)

Everything else depends on this. Complete and verify TASK 0 before any system.

### 0.1 Per-phase queue routing — `server/tick/queue.js`

```js
// server/tick/queue.js
import { redis } from '../db/redis.js';

// Action shape: { phase, category, resourceKey, trigger, sessionToken, context }
export async function enqueueAction(action) {
  const phase = action.phase ?? 3;
  await redis.rPush(`action:queue:${phase}`, JSON.stringify({ ...action, phase }));
}

export async function drainPhase(phase) {
  const key = `action:queue:${phase}`;
  const raw = await redis.lRange(key, 0, -1);
  await redis.del(key);
  return raw.map(r => JSON.parse(r));
}
```

### 0.2 Resolution order — `server/engine/resolution.js` (new)

```js
// server/engine/resolution.js
// Orders a phase's actions into deterministic resolution sequence.
// Rolls are drawn HERE (resolution time), against start-of-phase snapshot.
// EVERY action draws a roll, even uncontested/no-skill ones: resolve(token, null)
// returns { outcome: 'ungated', roll }. The roll orders contested claims; for an
// ungated action it never causes failure.

const CATEGORY_PRIORITY = { combat: 4, movement: 3, inventory: 2, communication: 1, other: 0 };

/**
 * @param actions  drained actions for one phase
 * @param rollFor  async (action) => { outcome, roll }
 *                 Always returns a roll. Gated: computes target from snapshot and calls
 *                 resolve/resolveOpposed. Ungated: resolve(token, null) → {outcome:'ungated', roll}.
 * Returns ordered list: [{ action, result }] in apply order.
 */
export async function orderPhase(actions, rollFor) {
  // 1. Group by resourceKey (null = its own singleton group)
  const groups = new Map();
  actions.forEach((a, i) => {
    const key = a.resourceKey ?? `__solo_${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ a, enqueueIdx: i });
  });

  const ordered = [];
  for (const group of groups.values()) {
    const rolled = [];
    for (const g of group) rolled.push({ ...g, result: await rollFor(g.a) });   // rollFor ALWAYS returns a roll

    // Gated failures claim nothing. Everything else (gated success + ungated) orders by roll.
    const failures  = rolled.filter(r => r.result.outcome === 'fail');
    const claimants = rolled.filter(r => r.result.outcome !== 'fail');          // successes + ungated

    claimants.sort((x, y) => {
      if (x.result.roll !== y.result.roll) return x.result.roll - y.result.roll;          // ascending roll
      const px = CATEGORY_PRIORITY[x.a.category] ?? 0, py = CATEGORY_PRIORITY[y.a.category] ?? 0;
      if (px !== py) return py - px;                                                       // category tiebreak
      return x.enqueueIdx - y.enqueueIdx;                                                  // FIFO tiebreak
    });

    for (const r of [...claimants, ...failures]) ordered.push({ action: r.a, result: r.result });
  }
  return ordered;
}
```

Apply-time premise checks (no re-rolling) live in each system's apply handler:
before mutating, re-read the target from hot-state; if gone/invalid, emit a
contextual no-op message and skip.

### 0.3 Maintenance registry — `server/tick/maintenance.js` (new)

```js
// server/tick/maintenance.js
import { logger } from '../log/logger.js';
const tasks = [];
export function registerMaintenanceTask(name, handler) { tasks.push({ name, handler }); }
export async function runMaintenance(currentTick, emitEvent) {
  for (const t of tasks) {
    try { await t.handler(currentTick, emitEvent); }
    catch (e) { logger.error('MAINTENANCE', 'task failed', { task: t.name, error: e.message }); }
  }
}
```

### 0.4 Tick loop rework — `server/tick/engine.js`

Replace the body of `processTick` (drain → arbitrate → process) with the sequential
pipeline. Keep init, scheduling, drift detection, clocks, and flush.

```js
// inside processTick(), replacing the old steps 1–4:
const inTickEvents = [];                          // Response-phase queue, drained same tick
const emit = (entityType, entityId, eventName, data = {}) =>
  inTickEvents.push({ entityType, entityId, eventName, data });

// Phases 1–3: drain, order, apply
for (const phase of [1, 2, 3]) {
  const actions = await drainPhase(phase);
  if (actions.length === 0) continue;
  const ordered = await orderPhase(actions, (a) => resolveActionRoll(a));   // rollFor adapter
  for (const { action, result } of ordered) {
    await applyAction(action, result, emit, tickCount);                     // dispatch to system handler
  }
}

// Phase 4: Response — drain in-tick events through the state machine, same tick.
// New events emitted by responses are appended and drained until empty (budget-capped).
let guard = 0;
while (inTickEvents.length && guard++ < config.maxResponseEventsPerTick) {
  const ev = inTickEvents.shift();
  await runTrigger(ev.eventName,
    { ...ev.data, targetType: ev.entityType, targetId: ev.entityId, currentTick: tickCount },
    (tokens, html) => parentPort.postMessage({ type: 'OUTPUT_MULTI', tokens, html }),
    emit);
}

// Phase 5: Maintenance, then clocks + flush (existing steps).
await runMaintenance(tickCount, emit);
await tickClocks();
if (tickCount % config.dbFlushIntervalTicks === 0) await flushDirtyState(tickCount);
```

`resolveActionRoll(action)` and `applyAction(action, result, emit, tick)` are thin
dispatchers that switch on `action.trigger`/`action.category` and call into the
relevant Phase 2 system module (navigation, combat, inventory, …). Each system
exports a `roll(action)` that **always returns a roll** — gated systems compute a
target and call `resolve`/`resolveOpposed`; ungated systems call `resolve(token, null)`
so a roll is still produced for ordering — and an
`apply(action, result, emit, tick)`. Register these dispatch entries in a small map
in `engine.js` so adding a system is one map entry, no loop edits.

Add to `config.js` defaults: `maxResponseEventsPerTick: 64`.

### 0.5 Conditions fix — `server/engine/conditions.js`

(a) Fix `emitEvent` arg order in `_tickEntityConditions`. The engine's emit is
`emit(entityType, entityId, eventName, data)` — call it in that order:
```js
await emitEvent(entityType, entityId, 'on_condition_expire', { conditionName: c.name });
```
(b) Make `tickConditions` iterate instances too:
```js
export async function tickConditions(currentTick, emitEvent) {
  for (const pattern of ['avatar:*', 'instance:*']) {
    const keys = await redis.keys(pattern);
    for (const key of keys) {
      const raw = await redis.get(key); if (!raw) continue;
      const entity = JSON.parse(raw);
      const [type] = key.split(':');                          // 'avatar' | 'instance'
      const id = key.slice(key.indexOf(':') + 1);             // avatarId OR "regionId:instanceId"
      await _tickEntityConditions(entity, type, id, currentTick, emitEvent);
      await redis.set(key, JSON.stringify(entity));
    }
  }
}
```
Register `tickConditions` as the first maintenance task.

### 0.6 Flush serializer — `server/db/sync.js`

Add a whitelist and apply it before each `update`. Handle null-region instance keys
(stored as the literal `"null:id"`):
```js
const AVATAR_COLS = ['name','stats','skills','wounds','sanity','stress','activeConditions',
  'currentLocationId','currentRegionId','visitedRegions','carryCapacity','encumberedThreshold',
  'coinCount','isState','state','metadata'];
const INSTANCE_COLS = ['count','isState','state','activeConditions','ownerType','ownerId',
  'currentLocationId','regionId','metadata'];
const pick = (obj, cols) => Object.fromEntries(cols.filter(c => c in obj).map(c => [c, obj[c]]));
// avatar:  data: pick(state, AVATAR_COLS)
// instance: const [r, i] = key.split(':'); const regionId = r === 'null' ? null : parseInt(r);
//           use where: { regionId_id: { regionId, id: parseInt(i) } }, data: pick(state, INSTANCE_COLS)
//           (if Prisma null-compound lookup is unreliable, fall back to update by unique pk)
```
Match `AVATAR_COLS`/`INSTANCE_COLS` to the actual Prisma schema after TASKs 1–5 add
columns; treat this list as the single source for "what persists."

### 0.7 State machine target loading + sigils — `server/engine/statemachine.js`

`_loadEntity`/`_saveEntity` currently key off `context.actorAvatarId` only. Extend so
a script attached to an object/exit/location/instance reads and writes *that* target:
```js
async function _loadEntity(context) {
  if (context.targetType === 'instance' && context.targetId) {
    const raw = await redis.get(`instance:${context.targetId}`); return raw ? JSON.parse(raw) : null;
  }
  if (context.targetType && context.targetType !== 'avatar' && context.targetId) {
    // location/exit/region: load from DB-backed hot key or Postgres as appropriate
    return await _loadStructural(context.targetType, context.targetId);
  }
  if (context.actorAvatarId) {
    const raw = await redis.get(`avatar:${context.actorAvatarId}`); return raw ? JSON.parse(raw) : null;
  }
  return null;
}
```
Before executing an action's args, substitute sigils from context:
`$attacker`→`context.attackerAvatarId`, `$target`→`context.targetId`, `#<id>` stays
literal id, `@<name>` resolves to an avatar id in scope. Add a `_substituteArgs(args,
context)` helper called in the action loop.

### 0.8 Startup wiring — `server/index.js`

After `registerBuiltins()`, append:
```js
import { registerMaintenanceTask } from './tick/maintenance.js';
import { tickConditions } from './engine/conditions.js';
// ...per-system register() calls (cmd_navigation, cmd_communication, ...)
registerMaintenanceTask('conditions', tickConditions);
registerMaintenanceTask('survival', survivalTick);        // TASK 9
registerMaintenanceTask('world-scripts', emitOnTick);     // TASK 12 (on_tick fan-out)
```

**Verify (TASK 0):**
1. Enqueue one action to each of phases 1–3; confirm the tick drains them in phase
   order and applies them.
2. Two actions with the same `resourceKey`, both gated, rolls 12 and 47 → the roll-12
   action applies first; the roll-47 action's apply handler sees the mutated state.
3. Two **ungated** actions on the same `resourceKey` (e.g. two `get` on one item) →
   both draw rolls; the lower roll claims the resource, the higher no-ops at apply.
4. Apply a 1-tick condition to an avatar and to a mob instance; confirm both expire
   on the next tick and `on_condition_expire` fires with correct `entityType`/`entityId`.
5. Flush an avatar whose hot-state carries a transient `locationName` field → no
   Prisma error; `locationName` not written.
6. `registerMaintenanceTask('noop', fn)` runs once per tick in registration order.

---

## TASK 1 — Stat Matrix

**Files:** `server/engine/stats.js` (new), `prisma/seed/world_config.js` (new).

- Seed `WorldState.config` with `majorBudget: 30`, `minorBudgetPerMajor: 20`.
- `defaultStats()` returns the 9-key JSON, all `{ value: 20, metadata: {} }`.
- `applyPointBuy(stats, allocation)` validates the two budgets (≤30 across majors;
  ≤20 across F/P/R within each major), enforces `statMin`/`statMax` (0–40), returns
  new stats. Reject over-budget allocation.
- `statContribution(value) = Math.min(value, 40)`.
- `getRollTarget(entity, statKey, skillId, conditionTargetStat)` =
  `statContribution(entity.stats[statKey].value) + skillRollContribution(skillId) +
  getStatModifier(entity, conditionTargetStat ?? statKey)`, then `Math.min(_, 70)`.
  `skillRollContribution` reads `SkillDefinition.rollContribution` (0 if no skill).
- Region `creation.majorBudget`/`minorBudgetPerMajor` null → fall back to world config.

**Verify:** new avatar has 9 stat keys at 20; point-buy of {Physical:+10…} applies and
rejects when a budget is exceeded; `getRollTarget` caps a 40-stat + 20-skill at 60 and
70 with a +10 condition; verify never exceeds 70.

---

## TASK 2 — Skill Definitions

**Schema (migrate):**
```prisma
model SkillDefinition {
  id                Int      @id @default(autoincrement())
  name              String   @unique
  stat              String
  rollContribution  Int
  autoSucceedSimple Boolean  @default(false)
  prerequisites     Json     @default("[]")
  unlocksActions    Json     @default("[]")
  attachedToObject  Boolean  @default(false)
  regionScoped      Boolean  @default(false)
  createdAt         DateTime @default(now())
  metadata          Json?
}
```
`avatar.skills` JSON: `{ "<skillId>": { "acquired": true, "metadata": {} } }`.
Spell skills live on `instance.state.skills` with the same shape.

**Files:** `server/engine/skills.js`, `prisma/seed/skills.js` (seed ≥3 starters).

- `grant_skill(avatarId, skillId)` (action vocab; `.add()` to `VALID_ACTION_FNS`):
  load skill def; verify every id in `prerequisites` is present & acquired on the
  avatar; if `regionScoped`, verify `skillId ∈ region.config.skillIds`; add to
  `avatar.skills`; audit-log. Reject (return false + reason) on any failed check.
- `revoke_skill(avatarId, skillId)`: remove; then cascade — any acquired skill whose
  `prerequisites` include `skillId` is also revoked (recurse).
- For `attachedToObject` skills, grant/revoke operate on `instance.state.skills`.

**Verify:** grant a starter skill → appears in `avatar.skills`; grant a skill with an
unmet prerequisite → rejected; revoke a prerequisite → dependent skill also removed;
spell skill grants to the instance, not the avatar.

---

## TASK 3 — Condition Library Seed

**File:** `prisma/seed/conditions.js`. Seed every condition from System 3 of the
master spec as world-level `Condition` rows. Key fields: `name`, `type`
(`mechanical`|`game`), `affectedStat` (use a comma form like `"phy_for,phy_pre"`
when two stats are affected — survival/getStatModifier reads each), `modifier`,
`defaultDurationTicks`, plus `overridesInput`/`overrideAction` carried in
`metadata` (the Phase 1 `Condition` model has no such columns).

Seed set (abridged — implement all): wound chain `wounded_1/2/3` (−5/−10/−15,
permanent) + `dying` (10 ticks, `overridesInput`, `overrideAction:null`); sanity
chain `shaken_1/2/3` + `broken` (10 ticks); break states `confusion`
(`random_move()`), `flee_state` (`action_run()`), `panic` (all −10), `comatose`
(respawn), `mental_break` (permanent, admin-clear); stress `strained`/`overwhelmed`;
`armor_broken`; `in_combat`; hunger/rest `hungry/starving/famished/tired/exhausted/
collapsed`; `encumbered`; and `silenced` (referenced by Communication).

Regions expose conditions via `config.conditionIds[]`.

**Verify:** seed runs idempotently (upsert by name); apply `wounded_1` →
`getStatModifier(avatar,'phy_for')` returns −5; applying it twice refreshes (no
stack); `dying` gets `expiresAt = tick + 10`.

---

## TASK 4 — Region Config Additions

No schema change — `Region.config` is open JSON. Add a defaults reader.

**File:** `server/engine/regionConfig.js`:
```js
const DEFAULTS = { dayNightCycleTicks: 100, defaultZoneType: 'SAFE',
  deathBehavior: 'respawn_region_entry', sanityBreakBehavior: 'condition_only',
  sanityBreakDurationTicks: 10, woundMax: 3, sanityMax: 3, skillIds: [], conditionIds: [],
  currency: { base: 'coin', coinWeightDivisor: 100, denominations: [] },
  creation: { majorBudget: null, minorBudgetPerMajor: null, statMin: 0, statMax: 40, startingSkillIds: [] } };
export function regionCfg(region) { return deepMerge(DEFAULTS, region.config ?? {}); }
```
`sanityBreakBehavior` ∈ {`condition_only`,`confusion`,`flee`,`panic`,`comatose`,
`mental_break`}. `creation.majorBudget`/`minorBudgetPerMajor` null → world config.

**Verify:** a region with `{}` config returns all defaults; a region overriding
`woundMax: 5` returns 5 while keeping other defaults.

---

## TASK 5 — Character Creation

**File:** `server/interface/cmd_creation.js` (+ a small inline prompt state machine in
session state). `/new-avatar {name}` works in any session.

Flow: validate name (unique across avatars, printable, 2–30 chars) → stat point-buy
prompt (present 3 majors, collect `majorBudget`, then F/P/R per major using
`minorBudgetPerMajor`) → optional alias setup (skippable) → create avatar with
`stats = defaultStats()+allocation`, `skills={}`, `wounds=0`, `sanity=0`, `stress=1`,
`visitedRegions=[]`, placed in The Void (region 0 / configured void id) → activate.

Add `on_first_visit` to `VALID_TRIGGERS` (`.add()`), and `has_visited(regionId)` to
`VALID_CONDITION_FNS` (true if `regionId ∈ avatar.visitedRegions`).

Region first-visit (in the navigation enter path / `on_enter` handling): if
`regionId ∉ avatar.visitedRegions` → push it; fire `on_first_visit` on the region's
entry location script (Response phase); never fires again.

**Verify:** `/new-avatar TestChar` → avatar created with 9 stats, placed in Void;
travel to a region → `on_first_visit` fires once, `regionId` recorded; travel again →
does not fire.

---

## TASK 6 — Navigation Commands

**File:** `server/interface/cmd_navigation.js`. Movement enqueues **phase 1**;
`look`/`exits` are inline readouts.

- `look [#location|$object]` — inline. Describe current/target location: exits,
  visible objects, characters, mobs; respect `isState.hidden`.
- `go {direction}` + aliases `n s e w ne nw se sw up down in out` — enqueue phase 1,
  category `movement`, `resourceKey: location:<region>:<fromLoc>:<dir>`. Apply checks:
  exit exists, not `isState.locked`, avatar not `in_combat` (else return
  "You cannot move while in combat. Use 'run' to attempt to flee."). On apply: move
  avatar, emit `on_exit` (origin) and `on_enter` (dest) to Response phase. Movement is
  ungated (no roll) unless a region gates it.
- `exits` — inline; list non-hidden exits (hidden shown only if avatar has a revealing
  skill).
- `travel {portal_name|#portal_id}` — enqueue phase 1; cross-region via portal.
- `teleport {#location}` — enqueue phase 1; `checkPermission` or ability gated.

**Verify:** `go n` with a north exit → avatar moves, `on_exit`/`on_enter` fire same
tick (Response); `go n` into a locked exit → rejected; `go n` while `in_combat` →
blocked with flee suggestion.

---

## TASK 7 — Communication Commands

**File:** `server/interface/cmd_communication.js`. All enqueue **phase 2**, category
`communication`, ungated, never blocked by combat. Before sending, check `silenced`
(mechanical) → "You cannot speak." for say/shout/tell.

- `say {text}` → all avatars in location; fire `on_say` on location script.
- `whisper @target {text}` → target in same location only.
- `shout {text}` → all avatars in region.
- `alert {text}` → power user: owned regions; admin: world. `checkPermission`.
- `tell @target {text}` → any online target, range-independent.
- `message @target {subject} {text}` → async mail (schema below); inbox cap 50/user.

**Schema (migrate):** `Message { id, fromUserId, toUserId, fromAvatarId?, toAvatarId?,
subject @default(""), body, sentAt @default(now()), readAt?, attachedInstanceId?,
metadata? }`. (Phase 1 left this model; confirm and add if absent.) Enforce 50-message
inbox in the handler.

All output via `renderOutput()`; format tags allowed.

**Verify:** `say Hello` → co-located avatars receive it in phase 2; apply `silenced` →
`say` blocked with message; `message` over the 50 cap → oldest-trim or reject (choose
reject + notice).

---

## TASK 8 — Inventory Commands

**File:** `server/interface/cmd_inventory.js`. State-changing verbs enqueue **phase 3**
(category `inventory`); `i`/`examine`/`look` are inline.

Weight model: object templates carry `weight Int`; `avatar.carryCapacity` is the hard
cap; exceeding `encumberedThreshold` applies `encumbered`; exceeding `carryCapacity`
rejects. Coin weight `Math.ceil(count / coinWeightDivisor)`.

- `get`/`take $object` — move to inventory; weight check; at/over threshold → apply
  `encumbered`; over cap → reject. No skill gate, but still **rolls for ordering**:
  when two avatars grab the same object in one tick, the lower roll claims it and the
  other's apply sees the object gone → "already taken".
- `drop $object` — to current location; fire `on_take`.
- `give $object @target` — to co-located avatar; fire `on_give`.
- `i`/`inventory` — inline; list carried weight / cap; show `encumbered` if present.
- `examine`/`x $object` — inline; description, visible state flags, game-type
  conditions only.
- `open`/`close $container` — set `isState.open`; fire `on_use`; check locked first.
- `put $object in $container` / `take $object from $container` — container must be open
  and reachable; reassign instance `ownerType: CONTAINER`, `ownerId: <containerId>`.
- `use $object [on $target]` — fire `on_use` on the object's script.
- `wear`/`equip $armor` / `remove $armor` — toggle `isState.equipped`; equipped armor
  modifier applies to PHY:RES (combat reads it).
- `trade @target` — open escrow (see TASK 15); both confirm within 10 ticks.

**Verify:** `get $sword` → weight checked, sword in inventory; exceed cap → `encumbered`
applied; `put $sword in $chest` (open) → sword owned by container instance; two
simultaneous `get` on one item → the lower roll claims it, the other gets "already
taken" (decided by roll, not arrival order).

---

## TASK 9 — Survival Tick

**File:** `server/engine/survival.js`. Export `survivalTick(currentTick, emit)`;
register as a maintenance task.

- **Stress accumulation:** the roll path emits a `stress_increment` event on
  `outcome:'fail'` of a gated roll (combat/skill checks emit it). Survival also adds
  stress when an avatar acted while holding `exhausted`, and exposes `apply_stress
  (avatarId, amount)` (action vocab). Clamp 1–20. At 20 → apply `overwhelmed` + `panic`.
  Implement stress as a per-tick reconcile: read pending increments from a Redis list
  `stress:pending` (pushed by the roll path), apply, clear.
- **Wound chain integrity:** for each avatar/mob, ensure conditions match the integer
  track (wounds 1→`wounded_1`, 2→`+wounded_2`, 3→`+wounded_3`+`dying`); apply missing,
  remove stale.
- **Sanity chain integrity:** same for `sanity` → `shaken_*` + break state.
- **Hunger/rest:** NOT managed here. Driven entirely by region `on_tick` story scripts
  (TASK 12 fan-out). Survival only enforces condition-chain integrity for whatever
  conditions exist.

**Verify:** a failed gated roll increments stress by 1 next maintenance; stress 20 →
`overwhelmed`+`panic`; set `avatar.wounds=3` (=woundMax) → `wounded_1/2/3`+`dying`
present with `dying` at 10 ticks.

---

## TASK 10 — Combat

**File:** `server/engine/combat.js`. Add combat vocab via `.add()`:
triggers `on_melee on_ranged on_trap on_horror on_dread on_mindbend on_wound on_kill
on_dying on_flee on_combat_start on_combat_end on_first_visit`; actions
`attack_target(target,skill_id) apply_wound(target) apply_sanity(target)
action_run(exit_id?) set_stance(name) end_combat() apply_stress(avatarId,amount)
random_move()` (grant/revoke from TASK 2).

- `attack $target [with $weapon]` — enqueue **phase 3**, category `combat`,
  `resourceKey: <targetType>:<targetId>` (so multiple attackers on one target form a
  contention group → ascending-roll order). Blocked in safe zones. On first contact
  apply `in_combat` to attacker and target; emit `on_combat_start`.
- **Resolution (phase 3 apply, ordered):** roll attacker target =
  `getRollTarget(attacker, 'phy_for', skillId, …)`.
  - strong → apply 1 wound (skip resistance).
  - weak → `resolveOpposed(attacker, defender, attackerPhyFor, defenderPhyRes +
    armorMod)`; defender wins ties; win → wound, loss → absorbed.
  - fail → no wound; emit failed `on_melee`.
  - Armor intercept: if a wound lands and defender has equipped intact armor →
    decrement durability; at 0 apply `armor_broken` to the armor instance.
  - Emit to Response: `on_wound` (if wound), `on_melee`, `on_kill` if wounds≥woundMax.
- **Stances:** `set_stance(name)` sets `avatar.state.activeStance` (effect next tick);
  combat checks the active stance subroutine for `on_melee`/`on_wound` handlers before
  generic ones.
- **Flee:** `run`/`flee` — enqueue **phase 1** (movement), so it resolves before the
  Action phase this tick. `resolveOpposed(fleer, attacker, fleerPhyPre, attackerPhyPre)`;
  fleer wins ties. Success → clear `in_combat`, move to a random unlocked exit, emit
  `on_flee`; fail → stay, emit failed `on_flee`.
- **Death:** wounds reach woundMax → `dying` (10 ticks). On `dying` expiry with no
  healing (detected in survival/maintenance via `on_condition_expire` or chain
  reconcile) → run `region.config.deathBehavior`; default `respawn_region_entry` clears
  wound/combat conditions and moves the avatar to the region entry location.

**Verify:** attack a mob in an open zone → ordered roll, wound on success, `in_combat`
on both; two attackers on one mob → lower roll lands first; mob wounds reach woundMax →
`on_kill` fires (Response), loot/death triggers; `dying` expiry → respawn.

---

## TASK 11 — Sanity / Horror Pathway

Extends combat.js. Horror sources fire `on_horror`/`on_dread`/`on_mindbend`.
Resolution mirrors combat on a different axis: `resolveOpposed(source, target,
sourceMenFor, targetMenRes)`; on success `apply_sanity(target)` (+1 sanity, chain
reconciled by survival). At `sanityMax` apply the break state per
`region.config.sanityBreakBehavior`:
- `condition_only` → `broken`; region scripts handle the rest.
- `confusion` → `confusion` (overridesInput → `random_move()`) for
  `sanityBreakDurationTicks`.
- `flee` → `flee_state` (overridesInput → `action_run()`) for duration.
- `panic` → `panic` (shared with stress max).
- `comatose` → `comatose` + respawn path (as death).
- `mental_break` → permanent `mental_break` (admin `revoke` to clear).

`overridesInput` dispatch: in the Maintenance/Response path, before normal input, an
avatar holding an `overridesInput` condition has its `overrideAction` executed (via
the action implementations), bypassing queued commands.

**Verify:** trigger `on_horror` → sanity resolution; reaching sanityMax under each
`sanityBreakBehavior` applies the correct state; a `confusion`-held avatar performs
`random_move()` instead of its queued command.

---

## TASK 12 — Mob Behavior

**File:** `server/engine/mobs.js`. Mobs are `ObjectInstance` (type `MOB`) with
`baseSchema.aiStates`, `defaultState`, `movementBehavior`, `stances`. Instance carries
`state.currentAiState`, `state.wounds`.

- **`on_tick` fan-out (the `world-scripts` maintenance task):** each tick, for active
  regions, emit `on_tick` to location/region/mob scripts. A mob's current AI state's
  `on_tick` rule runs (e.g. `idle: random_under(20) do random_move()`; `patrol:
  move($patrol_path_next)`). This is also what drives day/night (region clock already
  set by `tickClocks`) and hunger/rest depletion scripts.
- Mobs participate in combat as instances (rolls fall back to `Math.random` since no
  session PRNG — acceptable per Phase 1 resolver). Mob conditions tick via the
  instance path added in TASK 0.5.
- **Death:** apply `dead` condition; drop loot per `lootTable` (create coin/item
  instances in location); emit `on_death` for region respawn via `create_instance`;
  default no-respawn (instance stays dead).

**Verify:** an idle mob occasionally `random_move()`s on tick; a patrol mob follows its
path; attack a mob to woundMax → `dead`, loot dropped, `on_death` fired; mob `in_combat`
expires/clears like an avatar's.

---

## TASK 13 — Builder Commands

**File:** `server/interface/cmd_builder.js`. All `minUserType: 'POWER_USER'`;
`checkPermission` enforces region scope. Mutating world-structure commands may run
inline (builder edits aren't tick-contended) but must permission-check and audit-log.

World structure: `create location {name}`, `create exit {dir} to {#loc}`,
`create region {name}` (admin), `link {exitId} to {#loc}`, `describe {target} {text}`,
`rename {target} {name}`, `zone {#loc} {safe|open|dangerous}`, `lock`/`unlock {exitId}`
(`isState.locked`), `hide`/`show {exitId}` (`isState.hidden`).

Objects: `create template {name} {type}`, `create instance {$tplId} [at {#loc}]`,
`place $inst`, `remove $inst` (owner→WORLD, mark cleanup), `set $inst {key} {value}`
(`isState`).

Scripting: `edit {target}` (multiline editor; terminate `.`; parse+validate via
`parseDSL`; reject on error, save on success), `script {target} {dsl_line}` (append one
rule), `upload {target}` (HTTP endpoint, TASK 14), `view-script {target}` (inline),
`clear-script {target}`.

Skills/config: `grant @avatar {skillId}` / `revoke @avatar {skillId}` (TASK 2; log to
`PermissionLog`), `config {#region}` (inline display), `config {#region} {key} {value}`
(set top-level config key).

**Verify:** create location → exit → link → describe; navigate to it; `edit` a script
adding `on_enter do say("Welcome.")`, enter → message fires (Response phase).

---

## TASK 14 — File Upload Endpoint

**File:** `server/ws/server.js` — fill the designated `POST /upload/script` stub
(sanctioned). Max 64KB, `Content-Type: text/plain`, `Authorization: Bearer {token}`.

Steps: validate session token (header) → read `?type=&id=` query → `checkPermission`
(subject must have `write` on target) → `parseDSL(body)` → on error return 400 with
error list → on success save `Script` record (parsed JSON body) attached to target,
return 200 with script id.

**Verify:** valid upload saves a script and returns 200+id; malformed DSL returns 400
with errors and saves nothing; missing/invalid token → 401; oversized body → 413.

---

## TASK 15 — Economy Stub

**File:** `server/interface/cmd_economy.js`. Coin = `COIN` instance with `count`.
`avatar.coinCount` is the purse (or a coin instance owned by the avatar — match the
Phase 1 choice; spec treats purse as avatar-held coin). Coin weight via region
`coinWeightDivisor` (default 100).

- `drop {amount} coins` (phase 3) — create a `COIN` instance in location with
  `count: amount`, decrement purse.
- `get coins`/`take coins` (phase 3) — merge location coin instances into purse.
- `coins`/`balance` — inline.
- Vendor: `use $vendor` (inline price list); `buy {item} from $vendor` /
  `sell $object to $vendor` (phase 3) — buy checks funds, transfers coin to vendor,
  creates item in inventory; sell transfers item, credits purse at sell price.
- Trade escrow: `trade @target` opens a Redis-stored escrow (10-tick timeout); both use
  `offer $object` / `offer {amount} coins`; both `confirm` → atomic transfer; either
  `cancel` → abort. Use `OwnerType.ESCROW` during the session.

**Verify:** `balance` shows purse; `buy` deducts coin and adds item; open trade, both
offer + confirm → atomic transfer completes; timeout/`cancel` returns offered items.

---

## CLAUDE.md Update

After all tasks verify:
```markdown
## Phase Status
- **Phase 1** — COMPLETE (including pre-Phase-2 additions)
- **Phase 2** — COMPLETE
- **Phase 3** — Content building and delivery. READY TO BEGIN.
- **Phase 4** — Future stubs. NOT STARTED.
```
Also delete `.claude/rules/phase2-prep.md` and ensure `.claude/rules/
phase2-architecture.md` is in place.
