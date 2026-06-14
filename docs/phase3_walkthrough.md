# Phase 3 Builder & Player Walkthrough
## The Test Vale — Region 100

This document is a step-by-step guided run through every Phase 3 system using
the Test Vale seed. Follow it top to bottom on a freshly seeded database.
Each step shows the exact command to type and the expected client output.

Seed run order before starting:
```bash
node prisma/seed/conditions.js
node prisma/seed/skills.js
node prisma/seed/world_config.js
node prisma/seed/recipes.js
node prisma/seed/quests.js
node prisma/seed/test_vale.js
```

---

## 1. Setup

### 1.1 Register accounts

In two browser tabs (or sessions), register:
- **Builder account** (POWER_USER) — promote after registration:
  ```
  /register testbuilder password123
  admin user promote @testbuilder POWER_USER
  ```
- **Player account** (CHARACTER):
  ```
  /register testplayer password123
  /new-avatar Aela
  ```
- **Second player** (for trade testing):
  ```
  /register testplayer2 password123
  /new-avatar Brek
  ```

### 1.2 Teleport players to region 100

As ADMIN+:
```
admin avatar teleport @Aela 100 1
admin avatar teleport @Brek 100 1
```

**Expected:** `[Aela/Brek] teleported to 100:1`

---

## 2. Navigation & World-Alive

As Aela (at Vale Gate, location 100:1):

### 2.1 Look around

```
look
```
**Expected:** `Vale Gate — A wide stone archway...` with exits listed (east, south).

### 2.2 Traverse the loop

```
go east
```
**Expected:** You arrive at `Market Row`.

```
exits
```
**Expected:** Shows west (back to Vale Gate), north (Herb Hollow).

```
go north
go west
go west
```
(Herb Hollow → Forge Yard → Vale Gate loop complete)

### 2.3 Observe day/night script

Wait two minutes (20 ticks × 6 seconds = 2 min). Market Row fires its `on_tick`
script approximately every tick:

Navigate to Market Row and wait. After a few ticks:
**Expected:** `The market hum continues under the vale sky.`

---

## 3. Economy: Vendor

Navigate to Market Row (`go east` from Vale Gate).

### 3.1 Check coin balance

```
coins
```
**Expected:** `You are carrying 0 coins.`

### 3.2 Buy from the vendor

```
buy stick
```
**Expected:** `You offer to buy stick for 5 coins...` (then on next tick: `You buy stick for 5 coins.` if you have enough coins)

> Note: You need coins first. As admin, give some: `admin avatar give @Aela 100 coins`

With coins available:
```
buy stick
buy cloth
buy iron_ore
```
**Expected:** Each purchase confirmed on the next tick with the item appearing in inventory.

```
inventory
```
**Expected:** Lists stick, cloth, iron_ore with carry weight.

### 3.3 Sell an item (with buyback vendor)

```
sell $3
```
(Use the instance ID shown in inventory)
**Expected:** `You offer to sell stick for N coins...` → confirmed on next tick.

---

## 4. Crafting

### 4.1 List recipes

```
recipes
```
**Expected:** Lists torch, healing_draught, iron_dagger with ingredients and station requirements.

### 4.2 Craft torch (ungated, no station)

With stick and cloth in inventory:
```
craft torch
```
**Expected (next tick):** `You craft: torch.`

```
inventory
```
**Expected:** torch appears; stick and cloth consumed.

### 4.3 Craft iron_dagger (station gate)

Navigate to Forge Yard (`go south` from Vale Gate, then `go east` back if needed, or `go south` from Gate):

Without being at the forge:
```
craft iron_dagger
```
**Expected:** `You need a FORGE station here to craft this.`

Navigate to Forge Yard (`go south` from Vale Gate). With 2 iron_ore in inventory:
```
craft iron_dagger
```
**Expected (next tick):** `You craft: iron_dagger.`

### 4.4 Craft healing_draught (skill gate + station)

Without herbalism skill:
```
craft healing_draught
```
**Expected:** `You need the herbalism skill to craft this.`

Grant herbalism skill to Aela (as admin):
```
admin avatar grant-skill @Aela 1
```

Navigate to Herb Hollow (`go east` from Market Row from Vale Gate area, then `go north`):
```
craft healing_draught
```
(With 2 herbs in inventory and at ALCHEMY station)
**Expected (next tick):** `You craft: healing_draught.`

Without the alchemy station present:
```
craft healing_draught
```
**Expected:** `You need a ALCHEMY station here to craft this.`

---

## 5. Resource Nodes

Navigate to Herb Hollow (`100:4`).

### 5.1 Harvest herb

```
harvest herb
```
**Expected (next tick):** `You harvest: herb, herb.` (yields 2 herbs)

Attempting again immediately:
```
harvest herb
```
**Expected:** `That resource has already been harvested. Wait for it to respawn.`

Wait 15 ticks (~90 seconds):
**Expected (automatic, next respawn tick):** Node `depleted` flag clears. `harvest herb` succeeds again.

---

## 6. Quests

### 6.1 View available quests

```
quests
```
**Expected:** `You have no active quests.` (none accepted yet)

### 6.2 Accept a kill quest

```
quest accept 1
```
(Quest #1 = "Culling the Warren")
**Expected:** `Quest accepted: Culling the Warren.`

```
quests
```
**Expected:** Lists "Culling the Warren" as active with objective `○ Slay 3 warren goblins (0/3)`.

### 6.3 Kill goblins in The Warren

Navigate to The Warren (`go west` from Herb Hollow, which is reached via `go north` from Market Row):
```
attack goblin
```
Repeat until 3 goblins defeated. After each kill, the quest updates.

After third kill:
**Expected:** `Quest 'Culling the Warren' is ready to turn in. Use quest turn-in 1.`

```
quests
```
**Expected:** Objective shows `✓ Slay 3 warren goblins (3/3)`, status `complete`.

### 6.4 Turn in the quest

```
quest turn-in 1
```
**Expected:** `Quest turned in: Culling the Warren. Rewards granted.` (50 coins awarded)

```
coins
```
**Expected:** Shows 50 coins.

### 6.5 Collect + deliver quest (The Alchemist's Errand)

```
quest accept 2
```

Harvest 2 herbs in Herb Hollow (see §5). Then craft a `healing_draught` at the Alchemy station.

Navigate back to Market Row. Give the draught to the alchemist NPC (instance 2):
```
give healing_draught to $alchemist
```
**Expected:** Deliver objective completes; quest goes `complete`.

```
quest turn-in 2
```
**Expected:** `Quest turned in: The Alchemist's Errand. Rewards granted.` (herbalism skill granted if not already held)

---

## 7. Trade Escrow

Both Aela and Brek should be at the same location (e.g., Vale Gate 100:1).

### 7.1 Open trade

As Aela:
```
trade @Brek
```
**Expected (Aela):** `A trade window is open with Brek. Use offer, confirm, or cancel.`

### 7.2 Offer items

As Aela:
```
offer $7
```
(Instance ID of a stick or torch in Aela's inventory)
**Expected:** `You offer stick.`

As Brek:
```
offer 10 coins
```
**Expected:** `You offer 10 coins.`

### 7.3 Confirm trade

As Aela:
```
confirm
```
**Expected:** `You confirmed the trade. Waiting for the other party...`

As Brek:
```
confirm
```
**Expected (both):** `Trade complete.` — items swap on the next tick.

Verify with `inventory` on both sides.

### 7.4 Test re-offer invalidation

Open a new trade. Aela offers item. Brek confirms. Aela re-offers a different item:
**Expected:** Prior confirm is cleared. Both must re-confirm. Only one swap occurs.

### 7.5 Cancel trade

```
cancel
```
**Expected:** `Trade cancelled. Your items have been returned.` — offered items back in inventory.

### 7.6 Timeout test

Open a trade. Both offer items. Wait 10 ticks (~60 seconds) without confirming:
**Expected (reaper fires):** Trade cancelled automatically, items returned.

---

## 8. Puzzle / Structural State

Navigate to Forge Yard (`100:3`).

### 8.1 Use the lever

```
use lever
```
**Expected:** `The lever clunks into place. You hear a distant grinding sound.`

(The Forge Yard location script fires `on_use` when the lever's `isState.pulled` is true)
**Expected also:** `A stone door beneath the forge yard grinds open.`

### 8.2 Verify vault exit

```
exits
```
**Expected:** The `down` exit to Locked Vault now shows as available (no longer locked).

```
go down
```
**Expected:** You arrive at `Locked Vault`.

### 8.3 Verify persistence

Restart the server. Navigate back to Forge Yard. `exits` should still show `down` as unlocked.
`use lever` should say `The lever is already pulled.`
(Proves 0.2+0.3 persist structural and instance state across restarts.)

---

## 9. Builder Authoring

### 9.1 Create a new recipe via panel

As POWER_USER (testbuilder):
```
build recipe
```
**Expected:** Panel opens with fields for name, description, inputs, outputs, skill, station.

Fill in:
- Name: `fire_arrow`
- Inputs: `[{ templateId: 1001, quantity: 1 }, { templateId: 1003, quantity: 1 }]`
- Outputs: `[{ templateId: 1001, quantity: 1 }]` (placeholder — adjust as needed)
- Station: (blank)

Submit. **Expected:** `Recipe #N 'fire_arrow' created.`

As player (Aela):
```
recipes
```
**Expected:** `fire_arrow` appears in the list.

### 9.2 Create a new quest via panel

As POWER_USER:
```
build quest
```
**Expected:** Panel opens with fields for name, description, objectives (keyvalue-list), rewards.

Fill in:
- Name: `Forge Test`
- Objectives: `[{ id: "craft_test", type: "collect", target: "1003", count: 1, desc: "Craft a torch" }]`
- Coin Reward: `20`

Submit. **Expected:** `Quest #N 'Forge Test' created.`

As player (Aela):
```
quest accept {N}
```
Craft a torch (`craft torch` with stick + cloth in inventory).
**Expected:** Quest objective updates and quest goes `complete`.

```
quest turn-in {N}
```
**Expected:** 20 coins awarded.

---

## Walkthrough Complete

If all steps produce their expected outputs, Phase 3 is functioning correctly.
See `docs/phase3_playtest_checklist.md` for adversarial edge-case coverage.
