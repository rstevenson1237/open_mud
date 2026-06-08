# Phase 1 Architecture — Hard Constraints

These decisions are final. Do not work around them, reimplement them,
or suggest alternatives. Phase 2 builds on top — it never modifies these.

## Permission System

- `server/engine/permissions.js` contains the ONLY permission resolver.
- Every system calls `checkPermission()`. It is never duplicated.
- Resolution order: explicit DENIED → explicit GRANTED → OWNED_BY → type default → reject.
- ROOT bypasses all checks. GHOST is read-only regardless of grants.
- Any user type can act as a lower type (TYPE_RANK downgrade in opts.actingAs).
- All permission changes write to `PermissionLog` table (append-only audit).
- Object permissions are tied to the object itself, not who possesses it.
- Scripts inherit permissions of their attached object, not the triggering character.

## Tick Engine

- 6-second tick. Server-authoritative. Worker thread isolated from I/O thread.
- Tick drift: log warning + send ADMIN_ALERT to all ADMIN+ sessions. Do not crash.
- Action queue priority: combat(4) > movement(3) > inventory(2) > communication(1).
- Ties broken by random within priority. Single arbitration module only.
- Script execution budget: configurable per script (maxTransitions, maxEvents).
  Default: 32 transitions, 8 events per object per tick.
- Session grace on disconnect: 10 ticks, then drop to ghost (permission-based, no separate code path).

## State Machine & Scripting

- Scripts stored as structured JSON in `scripts.body`. NEVER raw text strings.
- DSL text is parsed at save time via `server/engine/dsl/parser.js`. Execution uses JSON only.
- State machine is the ONLY execution path for game logic. No ad-hoc game logic outside it.
- Local variables (`vars {}`) are scratch space — discarded after each tick run.
  Persistent state lives in `isState` or `state` JSON fields on instances.
- Spawning objects: via `create_instance` action in story scripts. No separate spawn manager.
- VALID_TRIGGERS, VALID_CONDITION_FNS, VALID_ACTION_FNS are Sets in parser.js.
  Phase 2 adds entries via `.add()` — never rewrites these Sets.

## Conditions

- No stacking. A condition applied twice refreshes duration only.
- Condition chains are authored in scripts (on_condition_apply triggers another condition).
- Mechanical conditions (locked, hidden, in_combat) checked by engine before script execution.
- `is_state` JSON field replaces ALL specific boolean flags. Never add `isLocked`, `isOpen` etc.
  Use `isState: { "locked": true, "open": false }` instead.

## Roll Engine

- All rolls: 0–99 uniform, seeded PRNG per session (xoshiro128ss in resolver.js).
- `resolve(token, target)` → `{ outcome: 'strong'|'weak'|'fail'|'ungated', roll, target }`
- Ungated actions (no target number) return `outcome: 'ungated'` — never a fail.
- Condition modifiers apply to target number before roll (positive = easier).
- Opposed: lower roll wins. Tie → defender wins.

## Data Layer

- Redis: hot game state. `maxmemory-policy noeviction`. AOF enabled.
- Postgres: source of truth. Prisma ORM. Never edit migration files manually.
- On crash: recover to last known-good Postgres state. Do not attempt mid-tick reconciliation.
- Dirty state flushed Redis → Postgres every N ticks (configurable) and on significant events.
- All schema tables include `metadata Json?` for Phase 2 extension. Never remove this column.

## Command Dispatch

- `server/interface/commands.js` exports `registerCommand` and `resolveCommand`.
- Phase 2 calls `registerCommand` to add commands. Never modifies commands.js internals.
- Aliases resolved in router before dispatch. User-level aliases stored in `User.aliases` JSON.
