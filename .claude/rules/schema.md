# Database Schema Conventions

## Prisma Schema Location

`prisma/schema.prisma` — single source of truth for all DB structure.

## Key Conventions

- Every model has `metadata Json?` — Phase 2 extension field. Never remove.
- Every enum has an `EXTENDED` value — for future type additions.
- `updatedAt DateTime @updatedAt` fields are managed by Prisma client only.
  Raw SQL inserts must supply `"updatedAt"` manually: `NOW()`.
- Namespace rule: IDs are integers 0–9999 per type per scope.
  Users: global 0–9999. Regions: global 0–9999.
  Locations, exits, objects: 0–9999 per region (composite primary keys).

## Object Ownership

`ObjectInstance` has `ownerType` (enum) + `ownerId` (string).
Owner types: USER, AVATAR, LOCATION, REGION, WORLD, CONTAINER, ESCROW, EXTENDED.
- Avatar carrying an item: ownerType=AVATAR, ownerId=avatarId
- Item placed in room: ownerType=LOCATION, ownerId="regionId:locationId"
- Item in a container: ownerType=CONTAINER, ownerId="regionId:instanceId"
- ESCROW: stub for Phase 2 trade sessions

## Object Templates vs Instances

- `ObjectTemplate`: factory definition. Stored at region level (or world level if regionId null).
- `ObjectInstance`: live copy with unique ID, owner, state, and active conditions.
- Template `baseSchema Json` defines the shape. Instance `state Json` carries live values.
- Template `lootTable Json` shape: `[{ templateId, quantity, dropChance }]` (dropChance 0–99).
- Mob templates include `aiStates`, `stances`, `movementBehavior` in baseSchema.
- Coin instances include `count Int?` field for quantity (1 coin object can hold 1 or 500 coins).

## isState vs state

- `isState Json` — generic boolean/string state flags. Replaces all specific booleans.
  Examples: `{ "open": true, "locked": false, "hidden": false }`
  The condition engine reads isState for mechanical checks (locked exit, hidden object).
- `state Json` — arbitrary live state for the instance or avatar.
  Examples: current AI state name, last attacker, cooldown tick.

## Avatar Schema

```
stats Json          -- { "stat_name": { "value": 50, "metadata": {} } }
                       Phase 2 defines named stats. Phase 1 leaves this generic.
skills Json         -- { "skill_id": { "proficiency": 0, "uses": 0, "cap": 99 } }
                       Phase 2 defines skill IDs and progression logic.
wounds Int          -- survival track (semantics defined Phase 2)
stress Int          -- survival track
hunger Int          -- survival track
rest Int            -- survival track (starts at 100)
carryCapacity Int   -- hard weight cap (unitless integers)
encumberedThreshold Int  -- condition threshold below cap
activeConditions Json    -- [{ name, conditionId, appliedAt, expiresAt, modifier, ... }]
aliases Json        -- { "alias": "canonical_command" }
```

## Region Config Shape

`Region.config Json` — structured but not schema-enforced. Phase 2 adds keys freely.
```json
{
  "toggles": {
    "combat": true, "pvp": false, "hunger": true, "rest": true,
    "wounds": true, "stress": true, "skills": true, "crafting": false, "story": false
  },
  "dayNightCycleTicks": 100,
  "defaultZoneType": "SAFE",
  "deathBehavior": "respawn_region_entry",
  "skillIds": [],
  "conditionIds": [],
  "currency": { "base": "coin", "denominations": [] }
}
```

## Migration Workflow

```bash
# After editing prisma/schema.prisma:
npm run db:generate    # regenerate Prisma client
npm run db:migrate     # create and apply migration (enter a name when prompted)
```

Never edit files in `prisma/migrations/` directly.
The mud Postgres user needs CREATEDB privilege for Prisma's shadow database:
`sudo -u postgres psql -c "ALTER USER mud CREATEDB;"`
