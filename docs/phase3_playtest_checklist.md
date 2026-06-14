# Phase 3 Manual Playtest Checklist

Adversarial and edge-case coverage for Phase 3. Run after the happy-path walkthrough.
Each item is a single observable assertion. Check off as you verify.

Tester: _______________   Date: _______________   Build commit: _______________

---

## Hardening (Task 0)

- [ ] `use lever` in the Forge Yard flips lever's own `isState.pulled` to `true`
      (verify: examine lever shows state, or check Redis `instance:100:10`)
- [ ] After server restart, Forge Yard vault exit is still unlocked; lever says
      "already pulled" (proves structural save + instance context both persist)
- [ ] `grep -rn "registerCommand('trade'" server/` returns exactly ONE hit in
      `cmd_economy.js` (no duplicate in `cmd_inventory.js`)
- [ ] A story script `on_death do create_instance(3004, 1)` spawns a real chest
      instance at location 1 with a unique ID (verify in DB: `SELECT id FROM "ObjectInstance" WHERE "templateId"=3004`)
- [ ] Calling `create_instance` twice in the same tick produces two distinct IDs
      (no collision from the Redis INCR allocator)
- [ ] `destroy_instance` removes the row from `ObjectInstance` AND clears the Redis
      key and dirty-flag

---

## Economy / Trade

- [ ] `buy stick` with 0 coins → `You need 5 coins but only have 0.` (no item spawned)
- [ ] `sell $X` to a vendor with `buyback: false` → `That vendor does not buy items.`
- [ ] Two players open a trade; one moves to a different room before confirming →
      trade cancels cleanly (`parties are no longer co-located`)
- [ ] Both parties `confirm`; one immediately re-`offer`s → confirmation is cleared;
      no swap occurs until both re-confirm
- [ ] `offer 999 coins` when avatar only has 50 → at confirm, both sides get
      `insufficient coins` message, nothing transferred, items returned
- [ ] Trade with both sides offering items; open for 10 ticks without confirming →
      reaper cancels and returns all offered items (check inventory on both sides)
- [ ] `cancel` during an active trade returns ESCROW items back to the offering avatar

---

## Crafting

- [ ] `craft torch` missing cloth → `Missing ingredients: 1x cloth (have 0)`; no
      inputs consumed
- [ ] `craft healing_draught` with herbalism skill, gated roll fails (check stress
      bumped by 1, no inputs consumed)
- [ ] `craft healing_draught` away from alchemy station → `You need a ALCHEMY station`
- [ ] Craft output exceeds carry capacity → items dropped to floor with warning;
      `examine` at the location shows the overflow item
- [ ] Two players craft the same `avatar:{avatarId}:inventory`-contended recipe in the
      same tick → both roll; both ordered deterministically; neither double-spends inputs
- [ ] Ungated `craft torch` with 1 stick + 1 cloth → always succeeds, roll drawn
      (ordering only), inputs consumed exactly once

---

## Quests

- [ ] `quest accept 2` (Alchemist's Errand) before completing quest 1 — if
      prerequisites are set → blocked with prerequisite message; without prerequisites
      → accepted (current seed has no prerequisites)
- [ ] Collect 2 herbs, drop them, then re-check `quests` → collect objective
      progress reflects current hold count (un-satisfies on drop)
- [ ] Deliver draught to alchemist NPC → objective completes AND the draught is
      consumed from inventory
- [ ] `quest turn-in 1` before quest is `complete` → `Quest is not complete yet.`
- [ ] Repeatable quest (Alchemist's Errand, `repeatable: true`) — after turn-in,
      `quest accept 2` succeeds again
- [ ] Quest reward item overflow (avatar at carry cap) → overflow drops to floor;
      coins still awarded
- [ ] `has_quest(1, "complete")` condition in a location script fires when quest 1
      is complete; does not fire when active or turned_in
- [ ] `grant_quest` DSL action from a region script → quest appears in avatar's
      `quests` list as active

---

## World / Regression

- [ ] Day/night clock still advances (check `world:clock:100` in Redis after several
      ticks; `dayTick` increments and wraps at `dayNightCycleTicks: 20`)
- [ ] Mob in The Warren (`instance 100:7`) still AI-moves between ticks (or at
      minimum `on_tick` fires without error)
- [ ] A condition applied to an avatar still expires after its duration ticks pass
      (apply `wounded_1` with duration 2, wait 2 ticks, condition removed)
- [ ] A condition applied to an ObjectInstance still expires and fires `on_condition_expire`
- [ ] `flushDirtyState` does NOT write transient fields like `locationName` to
      the DB (check `Avatar.stats` etc. in Postgres — no unknown column errors)
- [ ] `/help` as CHARACTER lists `craft`, `recipes`, `harvest`, `quests`, `trade`,
      `offer`, `confirm`, `cancel` in the appropriate permission tier
- [ ] `/help` as GHOST does NOT list CHARACTER-only commands

---

## Permissions

- [ ] CHARACTER cannot run `build recipe` → `Permission denied.` or permission error
- [ ] CHARACTER cannot run `build quest` → `Permission denied.`
- [ ] POWER_USER can run `build recipe` and `build quest` (via panel)
- [ ] POWER_USER creating a recipe/quest generates an audit log entry
      (check `PermissionLog` or the structured logger output)
- [ ] `build quest` with `regionScoped: true` — POWER_USER must own or have GRANTED
      on the region; another POWER_USER without access is denied

---

## Sign-Off

| | |
|---|---|
| Date | |
| Build commit | |
| Tester | |
| Outcome | PASS / FAIL |
| Open failures | |

All items checked PASS before merging Phase 3 to main.
