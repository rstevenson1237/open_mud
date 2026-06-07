# Phase 1 Implementation Guide
## MUD Engine — Essential Framework
### Target: Agentic AI Developer

---

## OVERVIEW & CONSTRAINTS

This guide implements Phase 1 of the MUD engine: the server process, data layer, state machine engine, scripting DSL parser, and browser UI shell. Phase 2 builds game commands on top of this foundation without modifying Phase 1 internals.

**Core constraint:** Phase 1 ships with empty extension points. Every schema table includes a `metadata` JSONB column. Every ENUM includes an `extended` value. The command dispatch table accepts dynamic registration. No hardcoded condition names anywhere in engine logic.

**Language:** Node.js (LTS) throughout. Vanilla JS on the client. No frameworks.

**Completion criteria for Phase 1:** A user can open a browser, connect, authenticate, receive server output, type a command, and have it processed through the permission resolver and state machine. The world is empty but the engine runs.

---

## TASK 1 — Project Scaffold

### 1.1 Directory structure

Create the following directory tree:

```
/
├── server/
│   ├── index.js              # entry point
│   ├── config.js             # environment config
│   ├── tick/
│   │   ├── engine.js         # tick loop (worker thread)
│   │   ├── queue.js          # action queue
│   │   ├── arbitrator.js     # conflict resolution
│   │   └── clock.js          # world clock
│   ├── db/
│   │   ├── postgres.js       # prisma client wrapper
│   │   ├── redis.js          # redis client wrapper
│   │   ├── sync.js           # redis → postgres flush
│   │   └── schema.prisma     # full schema definition
│   ├── engine/
│   │   ├── permissions.js    # single permission resolver
│   │   ├── conditions.js     # condition engine
│   │   ├── statemachine.js   # state machine runner
│   │   ├── dsl/
│   │   │   ├── parser.js     # DSL text → JSON
│   │   │   └── validator.js  # JSON script validation
│   │   └── resolver.js       # roll resolution
│   ├── interface/
│   │   ├── commands.js       # command dispatch registry
│   │   ├── router.js         # input → command or script
│   │   ├── output.js         # output emitter / formatter
│   │   └── builtins.js       # phase 1 built-in commands
│   ├── ws/
│   │   ├── server.js         # ws server, session handling
│   │   └── session.js        # session state, ghost fallback
│   └── log/
│       └── logger.js         # structured logger
├── client/
│   ├── index.html
│   ├── terminal.js
│   └── terminal.css
├── prisma/
│   └── schema.prisma
├── .env.example
└── package.json
```

### 1.2 package.json

```json
{
  "name": "mud-engine",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch server/index.js",
    "start": "node server/index.js",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^5.0.0",
    "ws": "^8.0.0",
    "redis": "^4.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "prisma": "^5.0.0"
  }
}
```

### 1.3 config.js

```js
// server/config.js
import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '3000'),
  tickMs: parseInt(process.env.TICK_MS ?? '6000'),
  tickDriftWarnMs: parseInt(process.env.TICK_DRIFT_WARN_MS ?? '500'),
  sessionGraceTicks: parseInt(process.env.SESSION_GRACE_TICKS ?? '10'),
  scriptMaxTransitions: parseInt(process.env.SCRIPT_MAX_TRANSITIONS ?? '32'),
  scriptMaxEvents: parseInt(process.env.SCRIPT_MAX_EVENTS ?? '8'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  databaseUrl: process.env.DATABASE_URL,
  dbFlushIntervalTicks: parseInt(process.env.DB_FLUSH_INTERVAL_TICKS ?? '10'),
  instanceArchiveAfterTicks: parseInt(process.env.INSTANCE_ARCHIVE_TICKS ?? '100'),
  defaultWorldDayTicks: parseInt(process.env.WORLD_DAY_TICKS ?? '100'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
```

**Verify:** `node -e "import('./server/config.js').then(m => console.log(m.config))"` prints config object with all keys.

---

## TASK 2 — Database Schema

### 2.1 Prisma schema

Create `prisma/schema.prisma`. This is the canonical Phase 1 schema. All tables include `metadata Json?` for Phase 2 extension. All enums include an `EXTENDED` value.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── ENUMS ───────────────────────────────────────────────────────────────────

enum UserType {
  ROOT
  ADMIN
  POWER_USER
  CHARACTER
  GHOST
  EXTENDED
}

enum PermissionLevel {
  OWNED_BY
  GRANTED
  DENIED
}

enum OwnerType {
  USER
  AVATAR
  LOCATION
  REGION
  WORLD
  CONTAINER   // instance owned by another instance
  ESCROW      // stub for phase 2 trade
  EXTENDED
}

enum ObjectType {
  ITEM
  CONTAINER
  WEAPON
  ARMOR
  KEY
  CONSUMABLE
  FIXTURE
  MOB
  COIN
  VENDOR
  EXTENDED
}

enum ZoneType {
  SAFE
  OPEN
  DANGEROUS
  EXTENDED
}

enum ConditionType {
  MECHANICAL
  GAME
  EXTENDED
}

enum ScriptAttachType {
  OBJECT_TEMPLATE
  OBJECT_INSTANCE
  LOCATION
  EXIT
  REGION
  AVATAR
  EXTENDED
}

// ─── USERS ───────────────────────────────────────────────────────────────────

model User {
  id            Int       @id  // 0000–9999, global namespace
  type          UserType  @default(CHARACTER)
  username      String    @unique
  passwordHash  String
  sessionToken  String?
  sessionExpiry DateTime?
  aliases       Json      @default("{}")  // { "i": "inventory", "l": "look" }
  inboxLimit    Int       @default(50)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  metadata      Json?

  avatars       Avatar[]
  permissions   Permission[] @relation("SubjectUser")
  messages      Message[]    @relation("ToUser")
  sentMessages  Message[]    @relation("FromUser")
  permissionLog PermissionLog[]
}

// ─── AVATARS ─────────────────────────────────────────────────────────────────

model Avatar {
  id           Int      @id  // 0000–9999, global namespace
  userId       Int
  name         String
  regionId     Int?
  locationId   Int?
  // Phase 1: generic stat/skill containers. Phase 2 defines named fields.
  stats        Json     @default("{}")
  // { "stat_name": { "value": 50, "metadata": {} } }
  skills       Json     @default("{}")
  // { "skill_id": { "proficiency": 0, "uses": 0, "cap": 99, "metadata": {} } }
  // Survival tracks — integers, semantics defined in phase 2
  wounds       Int      @default(0)
  stress       Int      @default(0)
  hunger       Int      @default(0)
  rest         Int      @default(100)
  // Weight — unitless integers
  carryCapacity      Int @default(100)
  encumberedThreshold Int @default(80)
  // Active conditions stored as array of condition IDs with state
  activeConditions   Json @default("[]")
  // { conditionId, appliedAt (tick), expiresAt (tick or null), state: {} }
  aliases      Json     @default("{}")
  isActive     Boolean  @default(false)  // currently active avatar for user
  disconnectedAt DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  metadata     Json?

  user         User     @relation(fields: [userId], references: [id])
}

// ─── REGIONS ─────────────────────────────────────────────────────────────────

model Region {
  id           Int      @id  // 0000–9999
  name         String
  ownerUserId  Int?
  // Config: phase 1 defines structure. Phase 2 populates values.
  config       Json     @default("{}")
  /*
  config shape:
  {
    "toggles": {
      "combat": true, "pvp": false, "hunger": true, "rest": true,
      "wounds": true, "stress": true, "skills": true,
      "crafting": false, "story": false
    },
    "dayNightCycleTicks": 100,
    "defaultZoneType": "SAFE",
    "deathBehavior": "respawn_region_entry",
    "skillIds": [],        // world skill IDs accessible in this region
    "conditionIds": [],    // world condition IDs accessible
    "currency": {
      "base": "coin",
      "denominations": []  // phase 2: [{ name, coinValue }]
    },
    "metadata": {}
  }
  */
  aliases      Json     @default("{}")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  metadata     Json?

  locations    Location[]
}

// ─── LOCATIONS ───────────────────────────────────────────────────────────────

model Location {
  id           Int      // 0000–9999 within region namespace
  regionId     Int
  name         String
  description  String   @default("")
  zoneType     ZoneType @default(SAFE)
  scriptId     Int?
  aliases      Json     @default("{}")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  metadata     Json?

  region       Region   @relation(fields: [regionId], references: [id])
  exits        Exit[]   @relation("ExitFrom")

  @@id([regionId, id])
}

// ─── EXITS ───────────────────────────────────────────────────────────────────

model Exit {
  id              Int
  regionId        Int
  fromLocationId  Int
  toLocationId    Int
  // Direction: canonical list — n s e w ne nw se sw up down in out
  // plus any named exit (door, gate, passage, etc.)
  direction       String
  // flags stored as state conditions — no separate boolean fields
  // e.g. locked = condition applied to this exit's instance
  conditionId     Int?
  aliases         Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  metadata        Json?

  region          Region   @relation(fields: [regionId], references: [id])
  fromLocation    Location @relation("ExitFrom", fields: [regionId, fromLocationId], references: [regionId, id])

  @@id([regionId, id])
}

// ─── OBJECT TEMPLATES (factory objects) ──────────────────────────────────────

model ObjectTemplate {
  id           Int        @id  // 0000–9999 global — templates are world-level
  regionId     Int?       // null = world-level template
  name         String
  type         ObjectType
  // Base schema — all instances inherit this, then carry instance-specific state
  baseSchema   Json       @default("{}")
  /*
  baseSchema shape by type (phase 1 defines containers, phase 2 fills):
  ALL types include:
    { "weight": 1, "value": 0, "aliases": {}, "description": "" }
  COIN adds:
    { "count": 1 }   — one coin object can hold 1 or 500 coins
  MOB adds:
    { "aiStates": {}, "stances": {}, "movementBehavior": "idle" }
  CONTAINER adds:
    { "capacity": 50, "isOpenByDefault": true }
  VENDOR adds:
    { "priceList": [] }  — phase 2 populates
  */
  scriptId     Int?
  lootTable    Json       @default("[]")
  // [{ templateId, quantity, dropChance }]  dropChance 0-99
  aliases      Json       @default("{}")
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  metadata     Json?

  instances    ObjectInstance[]
}

// ─── OBJECT INSTANCES ────────────────────────────────────────────────────────

model ObjectInstance {
  id           Int        // 0000–9999 within region namespace (or global for avatars)
  regionId     Int?       // null for objects in user namespace (home contents)
  templateId   Int
  ownerType    OwnerType
  ownerId      String     // flexible: userId, avatarId, "regionId:locationId", etc.
  // Live state — extends baseSchema, carries instance-specific values
  state        Json       @default("{}")
  // is_state: generic state bag — replaces all specific booleans
  // { "open": true, "locked": false, "hidden": false, "on_fire": false }
  isState      Json       @default("{}")
  activeConditions Json   @default("[]")
  // Coin-specific: count field for coin objects
  count        Int?       // only populated for COIN type
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  metadata     Json?

  template     ObjectTemplate @relation(fields: [templateId], references: [id])

  @@id([regionId, id])
}

// ─── PERMISSIONS ─────────────────────────────────────────────────────────────

model Permission {
  id            Int             @id @default(autoincrement())
  subjectType   String          // 'user', 'avatar', 'user_type'
  subjectId     String          // userId, avatarId, or type name
  objectType    String          // 'world', 'region', 'location', 'object_template', etc.
  objectId      String          // id of the target, or '*' for wildcard
  level         PermissionLevel
  grantedBy     Int?            // userId who set this
  createdAt     DateTime        @default(now())
  metadata      Json?

  user          User?    @relation("SubjectUser", fields: [subjectId], references: [id], map: "fk_perm_user")
}

// ─── PERMISSION AUDIT LOG ────────────────────────────────────────────────────

model PermissionLog {
  id          Int      @id @default(autoincrement())
  actorUserId Int
  action      String   // 'grant', 'deny', 'revoke', 'ownership_transfer'
  subjectType String
  subjectId   String
  objectType  String
  objectId    String
  level       String
  timestamp   DateTime @default(now())
  metadata    Json?

  actor       User     @relation(fields: [actorUserId], references: [id])
}

// ─── SCRIPTS ─────────────────────────────────────────────────────────────────

model Script {
  id             Int              @id @default(autoincrement())
  attachedToType ScriptAttachType
  attachedToId   String
  // body is always parsed DSL — never raw text
  body           Json
  /*
  body shape:
  [
    {
      "trigger": "on_enter",
      "conditions": [{ "fn": "is_state", "args": ["locked", false] }],
      "actions": [{ "fn": "say", "args": ["The door swings open."] }]
    }
  ]
  */
  maxTransitions Int?    // override global budget
  maxEvents      Int?    // override global budget
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  metadata       Json?
}

// ─── CONDITIONS ──────────────────────────────────────────────────────────────

model Condition {
  id              Int           @id @default(autoincrement())
  name            String        @unique
  type            ConditionType
  // affectedStat: name of stat to modify, or null
  affectedStat    String?
  // modifier: signed integer applied to stat target number
  modifier        Int           @default(0)
  // visibilityEffect: 'none', 'hidden', 'described'
  visibilityEffect String       @default("none")
  // defaultDurationTicks: null = permanent until removed
  defaultDurationTicks Int?
  // No stacking — discrete named conditions only
  // Phase 2 authors condition chains (exhausted → on_condition_apply → severely_exhausted)
  regionScoped    Boolean       @default(false)  // if true, only accessible where region grants it
  createdAt       DateTime      @default(now())
  metadata        Json?
}

// ─── MESSAGES ────────────────────────────────────────────────────────────────

model Message {
  id           Int      @id @default(autoincrement())
  fromUserId   Int
  toUserId     Int
  fromAvatarId Int?
  toAvatarId   Int?
  subject      String   @default("")
  body         String
  sentAt       DateTime @default(now())
  readAt       DateTime?
  // Phase 2: object attachment stub
  attachedInstanceId Int?
  metadata     Json?

  fromUser     User     @relation("FromUser", fields: [fromUserId], references: [id])
  toUser       User     @relation("ToUser", fields: [toUserId], references: [id])
}

// ─── WORLD STATE ─────────────────────────────────────────────────────────────

model WorldState {
  id           Int      @id @default(1)  // singleton
  tickCount    BigInt   @default(0)
  startedAt    DateTime @default(now())
  lastFlushAt  DateTime @default(now())
  metadata     Json?
}
```

### 2.2 Run migration

```bash
npx prisma migrate dev --name phase1_initial
npx prisma generate
```

**Verify:**
```bash
npx prisma studio
# All tables visible. Zero rows except WorldState (id=1, tickCount=0).
```

---

## TASK 3 — Logger

Implement before all other modules — everything depends on it.

```js
// server/log/logger.js
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 1;

function log(level, category, message, data = {}) {
  if (LEVELS[level] < current) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    ...data,
  };
  // Machine-state actions and permission changes always log regardless of level
  const forced = category === 'PERMISSION' || category === 'OWNERSHIP' || category === 'STATE_MACHINE';
  if (forced || LEVELS[level] >= current) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

export const logger = {
  debug: (cat, msg, data) => log('debug', cat, msg, data),
  info:  (cat, msg, data) => log('info',  cat, msg, data),
  warn:  (cat, msg, data) => log('warn',  cat, msg, data),
  error: (cat, msg, data) => log('error', cat, msg, data),
  // Always-on for auditable events
  audit: (cat, msg, data) => log('info', cat, msg, { ...data, _audit: true }),
};
```

**Verify:** `logger.audit('PERMISSION', 'grant', { subjectId: '1', objectId: 'world' })` produces a JSON line with `_audit: true`.

---

## TASK 4 — Database Clients

### 4.1 Postgres client

```js
// server/db/postgres.js
import { PrismaClient } from '@prisma/client';
import { logger } from '../log/logger.js';

export const db = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

db.$on('error', (e) => logger.error('DB', 'Prisma error', { message: e.message }));
db.$on('warn',  (e) => logger.warn('DB', 'Prisma warning', { message: e.message }));

export async function initDb() {
  await db.$connect();
  // Ensure WorldState singleton exists
  await db.worldState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, tickCount: 0n },
  });
  logger.info('DB', 'Postgres connected');
}
```

### 4.2 Redis client

```js
// server/db/redis.js
import { createClient } from 'redis';
import { logger } from '../log/logger.js';

export const redis = createClient({ url: process.env.REDIS_URL });

redis.on('error', (e) => logger.error('REDIS', 'Redis error', { message: e.message }));

export async function initRedis() {
  await redis.connect();
  logger.info('REDIS', 'Redis connected');
}

// Key conventions:
// avatar:{id}          → avatar hot state JSON
// location:{regionId}:{locationId}:contents → Set of "ownerType:ownerId" strings
// mob:{regionId}:{instanceId} → mob hot state JSON
// session:{token}      → { userId, avatarId, connectedAt, graceTick }
// world:tickCount      → current tick as string integer
// world:clock:{regionId} → { tick, dayTick, cycleLength }
```

### 4.3 State sync

```js
// server/db/sync.js
import { db } from './postgres.js';
import { redis } from './redis.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

// Called by tick engine every N ticks and on significant events.
// On crash: Postgres is source of truth. Redis has AOF for its own recovery.
// Never attempt partial reconciliation — recover to last known good Postgres state.
export async function flushDirtyState(tickCount) {
  const dirtyAvatars = await redis.sMembers('dirty:avatars');
  const dirtyInstances = await redis.sMembers('dirty:instances');

  for (const avatarId of dirtyAvatars) {
    const raw = await redis.get(`avatar:${avatarId}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    try {
      await db.avatar.update({ where: { id: parseInt(avatarId) }, data: state });
      await redis.sRem('dirty:avatars', avatarId);
    } catch (e) {
      logger.error('SYNC', 'Avatar flush failed', { avatarId, error: e.message });
    }
  }

  for (const key of dirtyInstances) {
    const [regionId, instanceId] = key.split(':');
    const raw = await redis.get(`instance:${regionId}:${instanceId}`);
    if (!raw) continue;
    const state = JSON.parse(raw);
    try {
      await db.objectInstance.update({
        where: { regionId_id: { regionId: parseInt(regionId), id: parseInt(instanceId) } },
        data: state,
      });
      await redis.sRem('dirty:instances', key);
    } catch (e) {
      logger.error('SYNC', 'Instance flush failed', { key, error: e.message });
    }
  }

  await db.worldState.update({
    where: { id: 1 },
    data: { tickCount: BigInt(tickCount), lastFlushAt: new Date() },
  });

  logger.info('SYNC', 'State flush complete', { tickCount, avatars: dirtyAvatars.length, instances: dirtyInstances.length });
}

// Mark entity as dirty — written to Redis immediately, flushed to Postgres on interval
export async function markDirty(type, id) {
  if (type === 'avatar') await redis.sAdd('dirty:avatars', String(id));
  if (type === 'instance') await redis.sAdd('dirty:instances', id); // "regionId:instanceId"
}
```

**Verify:**
1. Start Redis and Postgres locally.
2. `await initDb()` and `await initRedis()` both log success.
3. `await flushDirtyState(0)` completes without error on empty dirty sets.

---

## TASK 5 — Permission Resolver

This is the most critical Phase 1 module. Every system calls this. It is never duplicated.

```js
// server/engine/permissions.js
import { db } from '../db/postgres.js';
import { logger } from '../log/logger.js';

// Resolution order:
// 1. Explicit DENIED wins always
// 2. Explicit GRANTED
// 3. OWNED_BY
// 4. User-type default
// 5. Reject

const TYPE_DEFAULTS = {
  ROOT:       { level: 'OWNED_BY', scope: 'world' },
  ADMIN:      { level: 'GRANTED',  scope: 'all_regions' },
  POWER_USER: { level: 'GRANTED',  scope: 'assigned_regions' },
  CHARACTER:  { level: 'OWNED_BY', scope: 'self_and_home' },
  GHOST:      { level: 'GRANTED',  scope: 'read_only' },
};

// Any user type can act as a lower-level type.
// Type hierarchy for downgrade checks:
const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };

/**
 * Check whether a subject has permission to perform an action on a target.
 *
 * @param {object} subject  - { userId, userType, avatarId? }
 * @param {string} action   - e.g. 'write', 'read', 'execute', 'delete'
 * @param {object} target   - { type: 'region'|'location'|'object_template'|..., id: string }
 * @param {object} opts     - { actingAs?: UserType }  // for type downgrade
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
export async function checkPermission(subject, action, target, opts = {}) {
  const effectiveType = opts.actingAs
    ? (TYPE_RANK[opts.actingAs] <= TYPE_RANK[subject.userType] ? opts.actingAs : subject.userType)
    : subject.userType;

  // ROOT bypasses all checks
  if (effectiveType === 'ROOT') {
    return { allowed: true, reason: 'root' };
  }

  // GHOST is read-only regardless of grants
  if (effectiveType === 'GHOST' && action !== 'read') {
    return { allowed: false, reason: 'ghost_readonly' };
  }

  // Fetch all relevant permission rows
  const rows = await db.permission.findMany({
    where: {
      OR: [
        { subjectType: 'user',      subjectId: String(subject.userId) },
        { subjectType: 'user_type', subjectId: effectiveType },
        ...(subject.avatarId ? [{ subjectType: 'avatar', subjectId: String(subject.avatarId) }] : []),
      ],
      objectType: target.type,
      objectId: { in: [String(target.id), '*'] },
    },
  });

  // Explicit DENIED wins always
  const denied = rows.find(r => r.level === 'DENIED');
  if (denied) {
    logger.audit('PERMISSION', 'check_denied', { subject, action, target });
    return { allowed: false, reason: 'explicit_denied' };
  }

  // Explicit GRANTED
  const granted = rows.find(r => r.level === 'GRANTED');
  if (granted) return { allowed: true, reason: 'explicit_granted' };

  // OWNED_BY
  const owned = rows.find(r => r.level === 'OWNED_BY');
  if (owned) return { allowed: true, reason: 'owned_by' };

  // User-type defaults
  const def = TYPE_DEFAULTS[effectiveType];
  if (def) {
    if (def.scope === 'all_regions') return { allowed: true, reason: 'type_default_admin' };
    if (def.scope === 'read_only' && action === 'read') return { allowed: true, reason: 'type_default_ghost' };
  }

  return { allowed: false, reason: 'no_permission' };
}

/**
 * Grant, deny, or revoke a permission. Always logs.
 */
export async function setPermission({ actorUserId, subjectType, subjectId, objectType, objectId, level }) {
  const existing = await db.permission.findFirst({
    where: { subjectType, subjectId: String(subjectId), objectType, objectId: String(objectId) },
  });

  if (existing) {
    await db.permission.update({ where: { id: existing.id }, data: { level, grantedBy: actorUserId } });
  } else {
    await db.permission.create({ data: { subjectType, subjectId: String(subjectId), objectType, objectId: String(objectId), level, grantedBy: actorUserId } });
  }

  await db.permissionLog.create({
    data: { actorUserId, action: level === 'GRANTED' ? 'grant' : level === 'DENIED' ? 'deny' : 'revoke', subjectType, subjectId: String(subjectId), objectType, objectId: String(objectId), level },
  });

  logger.audit('PERMISSION', 'set', { actorUserId, subjectType, subjectId, objectType, objectId, level });
}
```

**Verify:**
1. Create a ROOT user in DB. `checkPermission({ userId: 1, userType: 'ROOT' }, 'write', { type: 'world', id: '*' })` → `{ allowed: true, reason: 'root' }`.
2. Create a GHOST user. `checkPermission({ userId: 2, userType: 'GHOST' }, 'write', ...)` → `{ allowed: false, reason: 'ghost_readonly' }`.
3. `setPermission(...)` writes both a Permission row and a PermissionLog row.

---

## TASK 6 — Roll Engine

```js
// server/engine/resolver.js
// Seeded PRNG — xoshiro128** implementation (no crypto dependency needed)
// One PRNG instance per session, seeded at session creation.

function xoshiro128ss(seed) {
  let [a, b, c, d] = [seed, seed ^ 0x9e3779b9, seed ^ 0x6c62272e, seed ^ 0xf3bcc908];
  return function() {
    const t = b << 9;
    let r = a * 5;
    r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a; d ^= b; b ^= c; a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return (r >>> 0) % 100; // 0–99
  };
}

// Session PRNG registry — keyed by session token
const prngs = new Map();

export function initSessionPrng(sessionToken) {
  const seed = sessionToken.split('').reduce((acc, c) => acc ^ c.charCodeAt(0) * 0x9e3779b9, 0x12345678);
  prngs.set(sessionToken, xoshiro128ss(seed >>> 0));
}

export function clearSessionPrng(sessionToken) {
  prngs.delete(sessionToken);
}

/**
 * Generate a 0–99 roll for a session.
 * Falls back to Math.random() if no session PRNG (e.g. mob actions).
 */
export function roll(sessionToken) {
  const prng = prngs.get(sessionToken);
  if (prng) return prng();
  return Math.floor(Math.random() * 100);
}

/**
 * Resolve a roll against a target number.
 * targetNumber: the skill/stat value the roll must be under to succeed.
 *   null or undefined = no gate (uncontested action, always succeeds on resolution).
 *
 * Returns: { outcome: 'strong' | 'weak' | 'fail' | 'ungated', roll, target }
 *
 * Degrees:
 *   roll < target AND tens(roll) < tens(target) → strong success
 *   roll < target AND tens(roll) === tens(target) → weak success
 *   roll >= target → fail
 *   no target → ungated (action proceeds, outcome still recorded for logs)
 */
export function resolve(sessionToken, targetNumber) {
  const r = roll(sessionToken);

  if (targetNumber === null || targetNumber === undefined) {
    return { outcome: 'ungated', roll: r, target: null };
  }

  // Clamp target to 1–99 (0 = always fail, 99 = near-certain success)
  const t = Math.max(1, Math.min(99, targetNumber));

  if (r >= t) return { outcome: 'fail', roll: r, target: t };

  const rollTens   = Math.floor(r / 10);
  const targetTens = Math.floor(t / 10);

  if (rollTens < targetTens) return { outcome: 'strong', roll: r, target: t };
  return { outcome: 'weak', roll: r, target: t };
}

/**
 * Opposed resolution: both parties roll. Lower result wins. Tie → defender wins.
 * Returns: { winner: 'attacker'|'defender', attackerResult, defenderResult }
 */
export function resolveOpposed(attackerToken, defenderToken, attackerTarget, defenderTarget) {
  const aResult = resolve(attackerToken, attackerTarget);
  const dResult = resolve(defenderToken, defenderTarget);

  // Both fail → defender wins (no action)
  if (aResult.outcome === 'fail' && dResult.outcome === 'fail') {
    return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
  }
  // Only attacker fails
  if (aResult.outcome === 'fail') return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
  // Only defender fails
  if (dResult.outcome === 'fail') return { winner: 'attacker', attackerResult: aResult, defenderResult: dResult };

  // Both succeed — lower roll wins
  if (aResult.roll < dResult.roll) return { winner: 'attacker', attackerResult: aResult, defenderResult: dResult };
  return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
}
```

**Verify:**
1. `resolve('test-session', 50)` with roll of 23 → `{ outcome: 'strong', roll: 23, target: 50 }`.
2. `resolve('test-session', 50)` with roll of 47 → `{ outcome: 'weak', roll: 47, target: 50 }`.
3. `resolve('test-session', 50)` with roll of 55 → `{ outcome: 'fail', roll: 55, target: 50 }`.
4. `resolve('test-session', null)` → `{ outcome: 'ungated' }`.
5. Verify PRNG is deterministic: same seed → same sequence across two runs.

---

## TASK 7 — Condition Engine

```js
// server/engine/conditions.js
import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';

/**
 * Apply a condition to an entity (avatar or object instance).
 * No stacking — if the condition is already present, refresh duration only.
 * Chain triggering (exhausted → severely_exhausted) is authored in scripts,
 * not in this engine function.
 *
 * @param {string} entityType  'avatar' | 'instance'
 * @param {string} entityId    avatarId or "regionId:instanceId"
 * @param {string} conditionName
 * @param {number|null} durationTicks  null = permanent
 * @param {number} currentTick
 */
export async function applyCondition(entityType, entityId, conditionName, durationTicks, currentTick) {
  const condDef = await db.condition.findUnique({ where: { name: conditionName } });
  if (!condDef) {
    logger.warn('CONDITIONS', 'Unknown condition', { conditionName });
    return false;
  }

  const key = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(key);
  if (!raw) return false;

  const entity = JSON.parse(raw);
  const conditions = entity.activeConditions ?? [];

  // No stacking — refresh or add
  const existing = conditions.findIndex(c => c.name === conditionName);
  const entry = {
    name: conditionName,
    conditionId: condDef.id,
    appliedAt: currentTick,
    expiresAt: durationTicks !== null ? currentTick + durationTicks : null,
    modifier: condDef.modifier,
    affectedStat: condDef.affectedStat,
    visibilityEffect: condDef.visibilityEffect,
  };

  if (existing >= 0) {
    conditions[existing] = entry; // refresh
  } else {
    conditions.push(entry);
  }

  entity.activeConditions = conditions;
  await redis.set(key, JSON.stringify(entity));
  await markDirty(entityType, entityId);

  logger.audit('STATE_MACHINE', 'condition_applied', { entityType, entityId, conditionName, durationTicks });
  return true;
}

/**
 * Remove a named condition from an entity.
 */
export async function removeCondition(entityType, entityId, conditionName) {
  const key = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(key);
  if (!raw) return false;

  const entity = JSON.parse(raw);
  const before = entity.activeConditions?.length ?? 0;
  entity.activeConditions = (entity.activeConditions ?? []).filter(c => c.name !== conditionName);

  if (entity.activeConditions.length === before) return false; // wasn't present

  await redis.set(key, JSON.stringify(entity));
  await markDirty(entityType, entityId);

  logger.audit('STATE_MACHINE', 'condition_removed', { entityType, entityId, conditionName });
  return true;
}

/**
 * Tick all conditions — decrement durations, remove expired, fire expiry events.
 * Called once per tick by the tick engine.
 *
 * @param {number} currentTick
 * @param {Function} emitEvent  function(entityType, entityId, eventName, data)
 */
export async function tickConditions(currentTick, emitEvent) {
  // Process active avatars
  const avatarKeys = await redis.keys('avatar:*');
  for (const key of avatarKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const entity = JSON.parse(raw);
    await _tickEntityConditions(entity, 'avatar', key.replace('avatar:', ''), currentTick, emitEvent);
    await redis.set(key, JSON.stringify(entity));
  }
}

async function _tickEntityConditions(entity, entityType, entityId, currentTick, emitEvent) {
  const conditions = entity.activeConditions ?? [];
  const expired = conditions.filter(c => c.expiresAt !== null && currentTick >= c.expiresAt);
  entity.activeConditions = conditions.filter(c => c.expiresAt === null || currentTick < c.expiresAt);

  for (const c of expired) {
    logger.audit('STATE_MACHINE', 'condition_expired', { entityType, entityId, conditionName: c.name });
    await emitEvent(entityType, entityId, 'on_condition_expire', { conditionName: c.name });
  }

  if (expired.length > 0) await markDirty(entityType, entityId);
}

/**
 * Check if an entity has a named condition active.
 */
export function hasCondition(entity, conditionName) {
  return (entity.activeConditions ?? []).some(c => c.name === conditionName);
}

/**
 * Get the net modifier for a stat from all active conditions.
 */
export function getStatModifier(entity, statName) {
  return (entity.activeConditions ?? [])
    .filter(c => c.affectedStat === statName)
    .reduce((sum, c) => sum + (c.modifier ?? 0), 0);
}
```

**Verify:**
1. Apply `exhausted` condition (duration 10) to an avatar at tick 5 → `expiresAt` = 15.
2. Run `tickConditions(15, emitFn)` → condition removed, `on_condition_expire` fired.
3. Apply same condition twice → only one entry in `activeConditions` (refresh, no stack).

---

## TASK 8 — DSL Parser & Validator

```js
// server/engine/dsl/parser.js
// Converts DSL text written by users into the structured JSON body stored in Script.body.
// Parsed and validated at save time. Execution uses JSON only.

const VALID_TRIGGERS = new Set([
  'on_enter', 'on_exit', 'on_use', 'on_tick', 'on_say',
  'on_give', 'on_take', 'on_attack', 'on_death',
  'on_time', 'on_condition_apply', 'on_condition_expire', 'on_event',
]);

const VALID_CONDITION_FNS = new Set([
  'has_condition', 'is_state', 'stat_above', 'stat_below',
  'has_item', 'in_state', 'user_type_is', 'zone_is', 'random_under',
]);

const VALID_ACTION_FNS = new Set([
  'say', 'move', 'give', 'take', 'set_state',
  'apply_condition', 'remove_condition', 'emit_event',
  'lock', 'unlock', 'enqueue', 'resolve_roll',
  'set_var', 'if_success', 'if_fail',
  'create_instance', 'destroy_instance',
]);

/**
 * Parse DSL source text into structured JSON.
 *
 * DSL format (one rule per line or block):
 *   on_enter [if has_condition("locked")] do say("The door is locked.")
 *   on_tick do emit_event("patrol_step", "#region")
 *
 * Returns: { ok: true, body: [...] } | { ok: false, errors: [...] }
 */
export function parseDSL(source) {
  const lines = source.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  const rules = [];
  const errors = [];

  for (const line of lines) {
    const result = _parseLine(line);
    if (result.error) {
      errors.push(result.error);
    } else {
      rules.push(result.rule);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, body: rules };
}

function _parseLine(line) {
  // Pattern: on_{trigger}[(args)] [if condition(args)] do action(args) [do action(args)]...
  const triggerMatch = line.match(/^(on_\w+)(?:\(([^)]*)\))?\s*/);
  if (!triggerMatch) return { error: `Cannot parse trigger in: ${line}` };

  const trigger = triggerMatch[1];
  const triggerArgs = triggerMatch[2] ? _parseArgs(triggerMatch[2]) : [];
  if (!VALID_TRIGGERS.has(trigger)) return { error: `Unknown trigger: ${trigger}` };

  let rest = line.slice(triggerMatch[0].length);
  const conditions = [];

  // Optional 'if' clause
  if (rest.startsWith('if ')) {
    const ifMatch = rest.match(/^if (\w+)\(([^)]*)\)\s*/);
    if (!ifMatch) return { error: `Cannot parse condition in: ${line}` };
    const fn = ifMatch[1];
    if (!VALID_CONDITION_FNS.has(fn)) return { error: `Unknown condition function: ${fn}` };
    conditions.push({ fn, args: _parseArgs(ifMatch[2]) });
    rest = rest.slice(ifMatch[0].length);
  }

  // 'do' clause (required)
  if (!rest.startsWith('do ')) return { error: `Expected 'do' in: ${line}` };
  rest = rest.slice(3);

  const actions = [];
  // May have multiple 'do action' separated by ' do '
  const actionParts = rest.split(' do ');
  for (const part of actionParts) {
    const actionMatch = part.trim().match(/^(\w+)\(([^)]*)\)$/);
    if (!actionMatch) return { error: `Cannot parse action in: ${part}` };
    const fn = actionMatch[1];
    if (!VALID_ACTION_FNS.has(fn)) return { error: `Unknown action function: ${fn}` };
    actions.push({ fn, args: _parseArgs(actionMatch[2]) });
  }

  return { rule: { trigger, triggerArgs, conditions, actions } };
}

function _parseArgs(str) {
  if (!str.trim()) return [];
  // Simple arg parser: handles quoted strings and bare values
  const args = [];
  const regex = /"([^"]*?)"|'([^']*?)'|([^,\s]+)/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}
```

**Verify:**
1. `parseDSL('on_enter do say("Welcome.")')` → `{ ok: true, body: [{ trigger: 'on_enter', conditions: [], actions: [{ fn: 'say', args: ['Welcome.'] }] }] }`.
2. `parseDSL('on_enter if has_condition("locked") do say("Locked!")')` → correct conditions array.
3. `parseDSL('on_unknown do say("x")')` → `{ ok: false, errors: ['Unknown trigger: on_unknown'] }`.
4. `parseDSL('// This is a comment\non_enter do say("hi")')` → comment stripped, one rule parsed.

---

## TASK 9 — State Machine Runner

```js
// server/engine/statemachine.js
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { hasCondition, getStatModifier, applyCondition, removeCondition } from './conditions.js';
import { resolve } from './resolver.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

/**
 * Run all scripts attached to entities in a location for a given trigger event.
 *
 * @param {string} trigger         e.g. 'on_enter'
 * @param {object} context         { locationId, regionId, actorAvatarId?, actorSessionToken?, data: {} }
 * @param {Function} emitOutput    function(sessionTokens[], outputHtml)
 * @param {Function} emitEvent     function(eventName, targetType, targetId, data)
 */
export async function runTrigger(trigger, context, emitOutput, emitEvent) {
  // Load all scripts for this location and its contained object instances
  const scripts = await _loadScriptsForContext(context);

  for (const script of scripts) {
    const budget = {
      transitions: script.maxTransitions ?? config.scriptMaxTransitions,
      events: script.maxEvents ?? config.scriptMaxEvents,
    };
    const vars = {}; // local scratch space, discarded after this run

    for (const rule of script.body) {
      if (rule.trigger !== trigger) continue;
      if (budget.transitions <= 0) {
        logger.warn('STATE_MACHINE', 'Script budget exceeded (transitions)', { scriptId: script.id });
        break;
      }

      const conditionsMet = await _evalConditions(rule.conditions, context, vars);
      if (!conditionsMet) continue;

      budget.transitions--;
      await _execActions(rule.actions, context, vars, budget, emitOutput, emitEvent, script.id);
    }
  }
}

async function _loadScriptsForContext(context) {
  const scripts = [];

  // Location script
  const loc = await db.location.findUnique({
    where: { regionId_id: { regionId: context.regionId, id: context.locationId } },
    select: { scriptId: true },
  });
  if (loc?.scriptId) {
    const s = await db.script.findUnique({ where: { id: loc.scriptId } });
    if (s) scripts.push(s);
  }

  // Instance scripts in this location
  const instances = await db.objectInstance.findMany({
    where: { regionId: context.regionId, ownerType: 'LOCATION', ownerId: String(context.locationId) },
    select: { templateId: true },
  });
  for (const inst of instances) {
    const tmpl = await db.objectTemplate.findUnique({ where: { id: inst.templateId }, select: { scriptId: true } });
    if (tmpl?.scriptId) {
      const s = await db.script.findUnique({ where: { id: tmpl.scriptId } });
      if (s) scripts.push(s);
    }
  }

  return scripts;
}

async function _evalConditions(conditions, context, vars) {
  for (const cond of conditions) {
    const result = await _evalCondition(cond, context, vars);
    if (!result) return false;
  }
  return true;
}

async function _evalCondition(cond, context, vars) {
  switch (cond.fn) {
    case 'is_state': {
      const [key, expectedRaw] = cond.args;
      const expected = expectedRaw === 'true' ? true : expectedRaw === 'false' ? false : expectedRaw;
      const entity = await _loadEntity(context);
      return entity?.isState?.[key] === expected;
    }
    case 'has_condition': {
      const entity = await _loadEntity(context);
      return entity ? hasCondition(entity, cond.args[0]) : false;
    }
    case 'in_state': {
      const entity = await _loadEntity(context);
      return entity?.state?.currentState === cond.args[0];
    }
    case 'stat_above': {
      const [statName, valueStr] = cond.args;
      const entity = await _loadEntity(context);
      const base = entity?.stats?.[statName]?.value ?? 0;
      const mod = entity ? getStatModifier(entity, statName) : 0;
      return (base + mod) > parseInt(valueStr);
    }
    case 'stat_below': {
      const [statName, valueStr] = cond.args;
      const entity = await _loadEntity(context);
      const base = entity?.stats?.[statName]?.value ?? 0;
      const mod = entity ? getStatModifier(entity, statName) : 0;
      return (base + mod) < parseInt(valueStr);
    }
    case 'random_under': {
      return Math.floor(Math.random() * 100) < parseInt(cond.args[0]);
    }
    case 'zone_is': {
      const loc = await db.location.findUnique({
        where: { regionId_id: { regionId: context.regionId, id: context.locationId } },
        select: { zoneType: true },
      });
      return loc?.zoneType === cond.args[0];
    }
    default:
      logger.warn('STATE_MACHINE', 'Unknown condition function', { fn: cond.fn });
      return false;
  }
}

async function _execActions(actions, context, vars, budget, emitOutput, emitEvent, scriptId) {
  for (const action of actions) {
    logger.audit('STATE_MACHINE', 'action_exec', { scriptId, fn: action.fn, args: action.args });

    switch (action.fn) {
      case 'say': {
        const [text] = action.args;
        emitOutput(context.locationSessionTokens ?? [], `<span class="say">${_sanitize(text)}</span>`);
        break;
      }
      case 'set_state': {
        // set_state(key, value) on the attached entity
        const [key, value] = action.args;
        const entity = await _loadEntity(context);
        if (entity) {
          entity.isState = entity.isState ?? {};
          entity.isState[key] = value === 'true' ? true : value === 'false' ? false : value;
          await _saveEntity(context, entity);
        }
        break;
      }
      case 'apply_condition': {
        const [condName, durStr] = action.args;
        const dur = durStr ? parseInt(durStr) : null;
        await applyCondition('avatar', context.actorAvatarId, condName, dur, context.currentTick);
        if (budget.events > 0) {
          budget.events--;
          await emitEvent('on_condition_apply', 'avatar', context.actorAvatarId, { conditionName: condName });
        }
        break;
      }
      case 'remove_condition': {
        await removeCondition('avatar', context.actorAvatarId, action.args[0], context.currentTick);
        break;
      }
      case 'emit_event': {
        if (budget.events <= 0) {
          logger.warn('STATE_MACHINE', 'Script budget exceeded (events)', { scriptId });
          break;
        }
        budget.events--;
        const [eventName, targetRef] = action.args;
        await emitEvent(eventName, 'ref', targetRef, context);
        break;
      }
      case 'set_var': {
        const [name, value] = action.args;
        vars[name] = value;
        break;
      }
      case 'create_instance': {
        const [templateId, locationId] = action.args;
        // Stub: Phase 2 implements full instantiation. Phase 1 logs intent.
        logger.info('STATE_MACHINE', 'create_instance_stub', { templateId, locationId });
        break;
      }
      case 'destroy_instance': {
        const [instanceId] = action.args;
        logger.info('STATE_MACHINE', 'destroy_instance_stub', { instanceId });
        break;
      }
      default:
        logger.warn('STATE_MACHINE', 'Unimplemented action (stub)', { fn: action.fn, scriptId });
    }
  }
}

async function _loadEntity(context) {
  if (!context.actorAvatarId) return null;
  const raw = await redis.get(`avatar:${context.actorAvatarId}`);
  return raw ? JSON.parse(raw) : null;
}

async function _saveEntity(context, entity) {
  if (!context.actorAvatarId) return;
  await redis.set(`avatar:${context.actorAvatarId}`, JSON.stringify(entity));
  const { markDirty } = await import('../db/sync.js');
  await markDirty('avatar', context.actorAvatarId);
}

function _sanitize(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

**Verify:**
1. Attach a script with `on_enter do say("Hello.")` to a location.
2. `runTrigger('on_enter', context, emitOutput, emitEvent)` → `emitOutput` called with hello text.
3. Script with 33 transitions → 32 execute, 33rd logs budget warning and stops.
4. All `action_exec` entries appear in log output.

---

## TASK 10 — Tick Engine (Worker Thread)

```js
// server/tick/engine.js
// Runs in a worker thread. Receives messages from main thread, processes tick, sends output.
import { workerData, parentPort } from 'worker_threads';
import { config } from '../config.js';
import { initRedis, redis } from '../db/redis.js';
import { initDb, db } from '../db/postgres.js';
import { flushDirtyState } from '../db/sync.js';
import { tickConditions } from '../engine/conditions.js';
import { runTrigger } from '../engine/statemachine.js';
import { logger } from '../log/logger.js';

let tickCount = 0;
let expectedTime = Date.now();

async function init() {
  await initDb();
  await initRedis();
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  tickCount = Number(world?.tickCount ?? 0n);
  logger.info('TICK', 'Tick engine initialized', { tickCount });
  scheduleTick();
}

function scheduleTick() {
  const now = Date.now();
  const delay = Math.max(0, expectedTime - now);
  setTimeout(processTick, delay);
}

async function processTick() {
  const start = Date.now();
  expectedTime += config.tickMs;
  tickCount++;

  try {
    // 1. Pull queued actions from Redis
    const actions = await drainActionQueue();

    // 2. Arbitrate conflicts
    const resolved = arbitrate(actions);

    // 3. Tick conditions (decrement durations, fire expiry events)
    await tickConditions(tickCount, emitEventToStateMachine);

    // 4. Process resolved actions through state machine
    for (const action of resolved) {
      await processAction(action);
    }

    // 5. Tick world clocks
    await tickClocks();

    // 6. Flush to Postgres every N ticks
    if (tickCount % config.dbFlushIntervalTicks === 0) {
      await flushDirtyState(tickCount);
    }

    // 7. Update tick count in Redis
    await redis.set('world:tickCount', String(tickCount));

    // 8. Check drift
    const elapsed = Date.now() - start;
    if (elapsed > config.tickDriftWarnMs) {
      logger.warn('TICK', 'Tick drift detected', { tickCount, elapsedMs: elapsed, limitMs: config.tickDriftWarnMs });
      parentPort.postMessage({ type: 'ADMIN_ALERT', message: `Tick ${tickCount} took ${elapsed}ms (limit ${config.tickDriftWarnMs}ms)` });
    }

  } catch (e) {
    logger.error('TICK', 'Tick error', { tickCount, error: e.message, stack: e.stack });
    // Do not crash — continue processing next tick
  }

  scheduleTick();
}

async function drainActionQueue() {
  const raw = await redis.lRange('action:queue', 0, -1);
  await redis.del('action:queue');
  return raw.map(r => JSON.parse(r));
}

// Priority: combat(4) > movement(3) > inventory(2) > communication(1) > other(0)
const PRIORITY = { combat: 4, movement: 3, inventory: 2, communication: 1 };

function arbitrate(actions) {
  // Group by target resource
  const byResource = {};
  for (const action of actions) {
    const key = action.resourceKey ?? 'none';
    if (!byResource[key]) byResource[key] = [];
    byResource[key].push(action);
  }

  const resolved = [];
  for (const [resource, group] of Object.entries(byResource)) {
    if (group.length === 1) { resolved.push(group[0]); continue; }
    // Sort by priority desc, then random tiebreak
    group.sort((a, b) => {
      const pa = PRIORITY[a.category] ?? 0;
      const pb = PRIORITY[b.category] ?? 0;
      if (pa !== pb) return pb - pa;
      return Math.random() - 0.5;
    });
    resolved.push(group[0]); // winner
    for (const loser of group.slice(1)) {
      logger.info('TICK', 'Action conflict resolved', { resource, winner: group[0].id, loser: loser.id });
      // Notify loser session
      parentPort.postMessage({ type: 'OUTPUT', sessionToken: loser.sessionToken, html: '<span class="system">Your action was interrupted.</span>' });
    }
  }
  return resolved;
}

async function processAction(action) {
  // Route to state machine trigger
  await runTrigger(
    action.trigger,
    { ...action.context, currentTick: tickCount },
    (tokens, html) => parentPort.postMessage({ type: 'OUTPUT_MULTI', tokens, html }),
    emitEventToStateMachine,
  );
}

async function emitEventToStateMachine(eventName, targetType, targetId, data) {
  // Queue as next-tick trigger
  await redis.rPush('action:queue', JSON.stringify({
    trigger: eventName,
    category: 'other',
    resourceKey: `${targetType}:${targetId}`,
    context: { ...data, targetType, targetId },
  }));
}

async function tickClocks() {
  const regionIds = await db.region.findMany({ select: { id: true, config: true } });
  for (const region of regionIds) {
    const cycle = region.config?.dayNightCycleTicks ?? config.defaultWorldDayTicks;
    const dayTick = tickCount % cycle;
    await redis.set(`world:clock:${region.id}`, JSON.stringify({ tick: tickCount, dayTick, cycleLength: cycle }));
  }
}

init();
```

**Verify:**
1. Worker starts, logs "Tick engine initialized".
2. After 6 seconds, logs tick 1 completion.
3. Intentionally slow a tick (Thread.sleep mock) — drift warning fires, parent receives `ADMIN_ALERT`.
4. Empty action queue processes cleanly.

---

## TASK 11 — Output Emitter

```js
// server/interface/output.js

// Format tag → HTML map. Whitelist only. No other tags rendered.
const TAG_MAP = {
  'b':   ['<strong>', '</strong>'],
  'i':   ['<em>', '</em>'],
  'dim': ['<span class="dim">', '</span>'],
};
const COLOR_WHITELIST = new Set(['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'gray']);

/**
 * Convert server output string with format tags to safe HTML.
 * Format tags: [b], [i], [dim], [color=red], [/]
 * Sigils (@, $, #) are plain text in output — substitution happens before this stage.
 */
export function renderOutput(text) {
  let html = _sanitizeBase(text);
  const stack = [];

  html = html.replace(/\[(\/?[\w=]+)\]/g, (match, tag) => {
    if (tag === '/') {
      const close = stack.pop();
      return close ?? '';
    }
    const colorMatch = tag.match(/^color=(\w+)$/);
    if (colorMatch) {
      const color = colorMatch[1];
      if (!COLOR_WHITELIST.has(color)) return '';
      stack.push('</span>');
      return `<span class="c-${color}">`;
    }
    const pair = TAG_MAP[tag];
    if (!pair) return '';
    stack.push(pair[1]);
    return pair[0];
  });

  // Close any unclosed tags
  while (stack.length > 0) html += stack.pop();
  return html;
}

/**
 * Build a STATUS payload for the client status bar.
 */
export function buildStatusPayload(avatar) {
  return {
    type: 'STATUS',
    data: {
      name: avatar.name,
      wounds: avatar.wounds,
      stress: avatar.stress,
      hunger: avatar.hunger,
      rest: avatar.rest,
      conditions: (avatar.activeConditions ?? [])
        .filter(c => c.visibilityEffect !== 'none')
        .map(c => c.name),
      locationName: avatar.locationName ?? '',
      zoneType: avatar.zoneType ?? 'SAFE',
    },
  };
}

function _sanitizeBase(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

**Verify:**
1. `renderOutput('[b]Hello[/] [color=red]world[/]')` → `<strong>Hello</strong> <span class="c-red">world</span>`.
2. `renderOutput('[color=purple]test[/]')` → `test` (purple not whitelisted, tag stripped).
3. `renderOutput('<script>alert(1)</script>')` → HTML-escaped, no script tag.
4. Unclosed `[b]` → tag auto-closed.

---

## TASK 12 — Command Dispatch Registry

```js
// server/interface/commands.js

// Command registry — Phase 2 registers commands here without modifying this file.
const registry = new Map();   // verb → { handler, aliases, tickCost, minUserType }
const aliasMap  = new Map();   // alias → canonical verb

/**
 * Register a command handler.
 * @param {string}   verb         Primary command name
 * @param {Function} handler      async (context) => { output: string, status?: object }
 * @param {object}   opts
 *   aliases      string[]    Additional names that map to this command
 *   tickCost     number      Default 1. Phase 2 may set higher for complex actions.
 *   minUserType  string      Minimum user type required ('GHOST'|'CHARACTER'|'POWER_USER'|'ADMIN'|'ROOT')
 */
export function registerCommand(verb, handler, opts = {}) {
  const entry = {
    verb,
    handler,
    aliases: opts.aliases ?? [],
    tickCost: opts.tickCost ?? 1,
    minUserType: opts.minUserType ?? 'CHARACTER',
  };
  registry.set(verb, entry);
  for (const alias of entry.aliases) {
    aliasMap.set(alias, verb);
  }
}

/**
 * Resolve a verb or alias to the canonical command entry.
 * Returns null if not found.
 */
export function resolveCommand(input) {
  const verb = input.trim().toLowerCase().split(/\s+/)[0];
  if (registry.has(verb)) return registry.get(verb);
  const canonical = aliasMap.get(verb);
  if (canonical) return registry.get(canonical);
  return null;
}

export function listCommands() {
  return [...registry.values()].map(e => ({ verb: e.verb, aliases: e.aliases }));
}
```

### 12.1 Built-in Phase 1 commands

```js
// server/interface/builtins.js
// Minimal commands needed to bootstrap and test Phase 1.
// Phase 2 registers all game commands on top of this.
import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';

export function registerBuiltins() {
  // /help — list available commands
  registerCommand('/help', async (ctx) => {
    const { listCommands } = await import('./commands.js');
    const cmds = listCommands().map(c => c.verb).join(', ');
    return { output: renderOutput(`[b]Available commands:[/] ${cmds}`) };
  }, { aliases: ['/?'], minUserType: 'GHOST' });

  // /whoami — show current session info
  registerCommand('/whoami', async (ctx) => {
    return { output: renderOutput(`[b]User:[/] ${ctx.userId} [b]Type:[/] ${ctx.userType} [b]Avatar:[/] ${ctx.avatarId ?? 'none'}`) };
  }, { aliases: [], minUserType: 'GHOST' });

  // /ping — latency test
  registerCommand('/ping', async (ctx) => {
    return { output: renderOutput('[dim]pong[/]') };
  }, { minUserType: 'GHOST' });
}
```

**Verify:**
1. `registerCommand('look', handler, { aliases: ['l'] })` → `resolveCommand('l')` returns the look handler.
2. Phase 2 calls `registerCommand` for 20 commands — all resolve correctly, no modification to commands.js.

---

## TASK 13 — Input Router

```js
// server/interface/router.js
import { resolveCommand } from './commands.js';
import { checkPermission } from '../engine/permissions.js';
import { parseDSL } from '../engine/dsl/parser.js';
import { redis } from '../db/redis.js';
import { renderOutput } from './output.js';
import { logger } from '../log/logger.js';

const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };
const RANK_TYPE = Object.fromEntries(Object.entries(TYPE_RANK).map(([k,v]) => [v,k]));

/**
 * Route raw input from a session to either a command handler or the action queue.
 *
 * Input forms:
 *   /command [args]         → command dispatch
 *   verb [args]             → command dispatch (aliases resolved)
 *   on_{trigger} ...        → DSL script save (requires write permission on attached object)
 *   // comment              → discard
 *
 * @param {string} raw           Raw input string from client
 * @param {object} session       { userId, userType, avatarId, sessionToken, regionId, locationId }
 * @returns {Promise<{ output?: string, queued?: boolean, error?: string }>}
 */
export async function routeInput(raw, session) {
  const input = raw.trim();

  // Discard comments
  if (input.startsWith('//')) return { output: null };

  // Resolve user aliases first (from user record, then from avatar record)
  const resolved = await resolveAlias(input, session);

  // Attempt command dispatch
  const cmd = resolveCommand(resolved);
  if (cmd) {
    // Permission check: ghost can only run GHOST-level commands
    const effective = session.actingAs ?? session.userType;
    if (TYPE_RANK[effective] < TYPE_RANK[cmd.minUserType]) {
      return { error: renderOutput('[color=red]Permission denied.[/]') };
    }

    const ctx = buildContext(session, resolved);
    try {
      const result = await cmd.handler(ctx);
      return { output: result.output, status: result.status };
    } catch (e) {
      logger.error('ROUTER', 'Command error', { cmd: cmd.verb, error: e.message });
      return { error: renderOutput('[color=red]Command failed.[/]') };
    }
  }

  // Queue as game action for next tick
  await redis.rPush('action:queue', JSON.stringify({
    id: `${session.sessionToken}:${Date.now()}`,
    sessionToken: session.sessionToken,
    trigger: 'on_command',
    category: 'other',
    resourceKey: `location:${session.regionId}:${session.locationId}`,
    context: {
      raw: input,
      userId: session.userId,
      userType: session.userType,
      avatarId: session.avatarId,
      regionId: session.regionId,
      locationId: session.locationId,
    },
  }));

  return { queued: true };
}

async function resolveAlias(input, session) {
  // Check user-level aliases
  const userRaw = await redis.get(`session:${session.sessionToken}`);
  if (!userRaw) return input;
  const sessionData = JSON.parse(userRaw);
  const aliases = sessionData.userAliases ?? {};
  const verb = input.split(/\s+/)[0].toLowerCase();
  if (aliases[verb]) {
    return aliases[verb] + input.slice(verb.length);
  }
  return input;
}

function buildContext(session, input) {
  return {
    raw: input,
    userId: session.userId,
    userType: session.userType,
    avatarId: session.avatarId,
    sessionToken: session.sessionToken,
    regionId: session.regionId,
    locationId: session.locationId,
    currentTick: null, // filled by tick engine when processing queued actions
  };
}
```

---

## TASK 14 — WebSocket Server & Session Management

```js
// server/ws/server.js
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { redis } from '../db/redis.js';
import { db } from '../db/postgres.js';
import { routeInput } from '../interface/router.js';
import { renderOutput, buildStatusPayload } from '../interface/output.js';
import { initSessionPrng, clearSessionPrng } from '../engine/resolver.js';
import { logger } from '../log/logger.js';
import { config } from '../config.js';

const sessions = new Map(); // sessionToken → WebSocket

export function startWsServer(port) {
  const httpServer = createServer((req, res) => {
    // Serve client files
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(readFileSync('./client/index.html'));
    } else if (req.url === '/terminal.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(readFileSync('./client/terminal.js'));
    } else if (req.url === '/terminal.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(readFileSync('./client/terminal.css'));
    } else {
      res.writeHead(404); res.end();
    }
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    let sessionToken = null;

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'AUTH') {
        sessionToken = await handleAuth(ws, msg);
        return;
      }

      if (msg.type === 'CMD' && sessionToken) {
        const session = await loadSession(sessionToken);
        if (!session) { send(ws, { type: 'ERROR', message: 'Session expired.' }); return; }
        const result = await routeInput(msg.input, session);
        if (result.output) send(ws, { type: 'OUTPUT', html: result.output });
        if (result.error)  send(ws, { type: 'OUTPUT', html: result.error });
        if (result.status) send(ws, result.status);
        return;
      }
    });

    ws.on('close', async () => {
      if (!sessionToken) return;
      const session = await loadSession(sessionToken);
      if (session?.avatarId) {
        // Mark disconnected — grace period managed by tick engine
        const currentTick = parseInt(await redis.get('world:tickCount') ?? '0');
        await redis.hSet(`session:${sessionToken}`, 'graceTick', currentTick + config.sessionGraceTicks);
        logger.info('WS', 'Client disconnected — grace period started', { sessionToken, graceTick: currentTick + config.sessionGraceTicks });
      }
      sessions.delete(sessionToken);
      clearSessionPrng(sessionToken);
    });
  });

  httpServer.listen(port, () => {
    logger.info('WS', `Server listening on port ${port}`);
  });

  return { wss, sessions };
}

async function handleAuth(ws, msg) {
  const { username, password } = msg;
  const user = await db.user.findUnique({ where: { username } });
  if (!user) { send(ws, { type: 'AUTH_FAIL', message: 'Unknown user.' }); return null; }

  // Phase 1: plain comparison placeholder — Phase 2 implements bcrypt
  const valid = user.passwordHash === password;
  if (!valid) { send(ws, { type: 'AUTH_FAIL', message: 'Invalid credentials.' }); return null; }

  const token = generateToken();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.user.update({ where: { id: user.id }, data: { sessionToken: token, sessionExpiry: expiry } });
  await redis.set(`session:${token}`, JSON.stringify({
    userId: user.id,
    userType: user.type,
    avatarId: null,
    sessionToken: token,
    regionId: null,
    locationId: null,
    userAliases: user.aliases ?? {},
    connectedAt: Date.now(),
  }));

  initSessionPrng(token);
  sessions.set(token, ws);

  send(ws, { type: 'AUTH_OK', message: renderOutput(`[b]Connected.[/] Welcome, ${user.username}.`) });
  logger.info('WS', 'User authenticated', { userId: user.id, userType: user.type });
  return token;
}

async function loadSession(token) {
  const raw = await redis.get(`session:${token}`);
  return raw ? JSON.parse(raw) : null;
}

// Called by tick worker thread messages
export function handleWorkerMessage(msg, sessions) {
  if (msg.type === 'OUTPUT' && msg.sessionToken) {
    const ws = sessions.get(msg.sessionToken);
    if (ws) send(ws, { type: 'OUTPUT', html: msg.html });
  }
  if (msg.type === 'OUTPUT_MULTI' && msg.tokens) {
    for (const token of msg.tokens) {
      const ws = sessions.get(token);
      if (ws) send(ws, { type: 'OUTPUT', html: msg.html });
    }
  }
  if (msg.type === 'ADMIN_ALERT') {
    // Deliver to all ADMIN+ sessions
    for (const [token, ws] of sessions) {
      send(ws, { type: 'OUTPUT', html: renderOutput(`[color=yellow][b]ADMIN:[/] ${msg.message}[/]`) });
    }
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function generateToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
```

---

## TASK 15 — Browser Client

### 15.1 index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MUD</title>
  <link rel="stylesheet" href="/terminal.css">
</head>
<body>
  <div id="app">
    <div id="status-bar">
      <span id="s-name"></span>
      <span id="s-wounds"></span>
      <span id="s-stress"></span>
      <span id="s-hunger"></span>
      <span id="s-rest"></span>
      <span id="s-location"></span>
      <span id="s-zone"></span>
      <span id="s-conditions"></span>
    </div>
    <div id="output" role="log" aria-live="polite"></div>
    <div id="input-row">
      <span id="prompt">&gt;</span>
      <input id="cmd" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Command input">
    </div>
  </div>
  <script src="/terminal.js"></script>
</body>
</html>
```

### 15.2 terminal.css

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0d0d0d;
  --fg: #c8c8c8;
  --prompt: #4a9;
  --dim: #555;
  --status-bg: #111;
  --font: 'Courier New', Courier, monospace;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 14px;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

#app { display: flex; flex-direction: column; height: 100%; }

#status-bar {
  background: var(--status-bg);
  padding: 4px 10px;
  font-size: 12px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  border-bottom: 1px solid #222;
  flex-shrink: 0;
}
#status-bar span { color: #888; }
#status-bar span.active { color: var(--fg); }

#output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  scroll-behavior: smooth;
}
#output .say    { color: #aef; }
#output .system { color: #fa0; }
#output .dim    { color: var(--dim); }
#output .c-red     { color: #f66; }
#output .c-green   { color: #6f6; }
#output .c-blue    { color: #66f; }
#output .c-yellow  { color: #ff6; }
#output .c-cyan    { color: #6ff; }
#output .c-magenta { color: #f6f; }
#output .c-white   { color: #fff; }
#output .c-gray    { color: #888; }

#input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid #222;
  flex-shrink: 0;
}
#prompt { color: var(--prompt); user-select: none; }
#cmd {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--font);
  font-size: 14px;
  caret-color: var(--prompt);
}
```

### 15.3 terminal.js

```js
// client/terminal.js
(function() {
  const output   = document.getElementById('output');
  const cmdInput = document.getElementById('cmd');
  const history  = [];
  let histIdx    = -1;
  let userScrolled = false;
  let ws         = null;

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      // Prompt for login
      appendLine('<span class="system">Connected. Use /login username password to authenticate.</span>');
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'OUTPUT')    appendLine(msg.html);
      if (msg.type === 'AUTH_OK')   appendLine(msg.message);
      if (msg.type === 'AUTH_FAIL') appendLine(`<span class="c-red">${msg.message}</span>`);
      if (msg.type === 'ERROR')     appendLine(`<span class="c-red">${msg.message}</span>`);
      if (msg.type === 'STATUS')    updateStatus(msg.data);
    };

    ws.onclose = () => {
      appendLine('<span class="c-red">Disconnected. Reconnecting in 5s...</span>');
      setTimeout(connect, 5000);
    };

    ws.onerror = () => ws.close();
  }

  // ── Output ─────────────────────────────────────────────────────────────────
  function appendLine(html) {
    const div = document.createElement('div');
    div.innerHTML = html; // already sanitized server-side
    output.appendChild(div);
    if (!userScrolled) output.scrollTop = output.scrollHeight;
  }

  output.addEventListener('scroll', () => {
    userScrolled = output.scrollTop + output.clientHeight < output.scrollHeight - 10;
  });

  // ── Status bar ─────────────────────────────────────────────────────────────
  function updateStatus(data) {
    setText('s-name',       data.name ?? '');
    setText('s-wounds',     data.wounds != null ? `WND:${data.wounds}` : '');
    setText('s-stress',     data.stress != null ? `STR:${data.stress}` : '');
    setText('s-hunger',     data.hunger != null ? `HNG:${data.hunger}` : '');
    setText('s-rest',       data.rest   != null ? `RST:${data.rest}`   : '');
    setText('s-location',   data.locationName ?? '');
    setText('s-zone',       data.zoneType ?? '');
    setText('s-conditions', (data.conditions ?? []).join(' · '));
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = text ? 'active' : '';
  }

  // ── Command input ──────────────────────────────────────────────────────────
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = cmdInput.value.trim();
      if (!input) return;
      history.unshift(input);
      if (history.length > 50) history.pop();
      histIdx = -1;
      cmdInput.value = '';

      // Local /login handling — never sent raw to server
      if (input.startsWith('/login ')) {
        const [, username, password] = input.split(' ');
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'AUTH', username, password }));
        return;
      }

      appendLine(`<span class="dim">&gt; ${escapeHtml(input)}</span>`);
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'CMD', input }));
    }

    if (e.key === 'ArrowUp') {
      histIdx = Math.min(histIdx + 1, history.length - 1);
      cmdInput.value = history[histIdx] ?? '';
      e.preventDefault();
    }
    if (e.key === 'ArrowDown') {
      histIdx = Math.max(histIdx - 1, -1);
      cmdInput.value = histIdx >= 0 ? history[histIdx] : '';
      e.preventDefault();
    }

    // Basic autocomplete stub — Phase 2 populates command list
    if (e.key === 'Tab') {
      e.preventDefault();
      // Stub: emit hint that autocomplete is not yet populated
    }
  });

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  connect();
  cmdInput.focus();
})();
```

---

## TASK 16 — Server Entry Point

```js
// server/index.js
import { Worker } from 'worker_threads';
import { config } from './config.js';
import { initDb } from './db/postgres.js';
import { initRedis } from './db/redis.js';
import { startWsServer, handleWorkerMessage } from './ws/server.js';
import { registerBuiltins } from './interface/builtins.js';
import { logger } from './log/logger.js';

async function main() {
  logger.info('SERVER', 'Starting MUD engine');

  await initDb();
  await initRedis();
  registerBuiltins();

  const { sessions } = startWsServer(config.port);

  const tickWorker = new Worker(new URL('./tick/engine.js', import.meta.url));
  tickWorker.on('message', (msg) => handleWorkerMessage(msg, sessions));
  tickWorker.on('error',   (e)   => logger.error('SERVER', 'Tick worker error', { error: e.message }));
  tickWorker.on('exit',    (code) => {
    if (code !== 0) logger.error('SERVER', 'Tick worker exited unexpectedly', { code });
  });

  logger.info('SERVER', `MUD engine running on port ${config.port}`);
}

main().catch(e => {
  logger.error('SERVER', 'Fatal startup error', { error: e.message, stack: e.stack });
  process.exit(1);
});
```

---

## TASK 17 — Integration Verification

Perform these checks in order after all tasks are complete.

### 17.1 Server boots

```bash
npm run db:migrate
npm run db:generate
node server/index.js
```
Expected log output:
```
{"level":"info","category":"DB","message":"Postgres connected"}
{"level":"info","category":"REDIS","message":"Redis connected"}
{"level":"info","category":"WS","message":"Server listening on port 3000"}
{"level":"info","category":"TICK","message":"Tick engine initialized","tickCount":0}
```

### 17.2 Client connects

Open browser to `http://localhost:3000`. Terminal renders. "Connected." message appears.

### 17.3 Authentication

Type `/login testuser testpass` (after seeding a user record directly in Postgres).
Expected: `Connected. Welcome, testuser.`

### 17.4 Built-in commands

Type `/ping` → `pong`
Type `/whoami` → user info
Type `/help` → command list

### 17.5 Tick fires

Wait 6 seconds after boot. Log shows:
```
{"level":"info","category":"TICK","message":"...tick 1..."}
```

### 17.6 Permission resolver

Seed a GHOST user. Attempt a write action from that session. Confirm `ghost_readonly` rejection in log.

### 17.7 Roll engine

Seed a session PRNG with a known token. Call `resolve(token, 50)` ten times. Confirm same sequence on repeated runs with same seed. Confirm all rolls are 0–99.

### 17.8 DSL parser round-trip

POST a valid DSL string through a test route, confirm parsed JSON stored in `scripts` table. Confirm raw text is never stored.

### 17.9 Condition lifecycle

Apply a condition with duration 3 to an avatar at tick 0. Run `tickConditions` for ticks 1, 2, 3. Confirm condition absent from avatar state after tick 3. Confirm `on_condition_expire` was emitted.

### 17.10 State persistence

Write avatar state to Redis. Trigger `flushDirtyState`. Confirm Postgres avatar record updated. Kill and restart server. Confirm avatar state recoverable from Postgres.

### 17.11 Drift warning

In development, temporarily set `TICK_MS=100` and add a 200ms artificial delay to `processTick`. Confirm drift warning appears in log and admin clients receive alert.

---

## PHASE 1 EXTENSION POINTS — CHECKLIST

Before handing to Phase 2, confirm all of the following are true:

- [ ] Every Prisma model has a `metadata Json?` column
- [ ] Every ENUM has an `EXTENDED` value
- [ ] `registerCommand` accepts new handlers without modifying `commands.js`
- [ ] Trigger vocabulary in DSL parser is a `Set` — Phase 2 adds entries via `VALID_TRIGGERS.add()`
- [ ] Action vocabulary is a `Set` — Phase 2 adds entries via `VALID_ACTION_FNS.add()`
- [ ] Condition vocabulary is a `Set` — Phase 2 adds entries via `VALID_CONDITION_FNS.add()`
- [ ] No hardcoded condition names in engine logic (only in seed data)
- [ ] `is_state` is used instead of any specific boolean field
- [ ] `state` and `isState` JSON fields on instances accept arbitrary keys
- [ ] Region `config` JSON is structurally defined but not enforced — Phase 2 adds keys freely
- [ ] `object_templates.baseSchema` accepts arbitrary type-specific fields
- [ ] `avatar.stats` and `avatar.skills` are schema-free JSON — Phase 2 defines named fields
- [ ] `create_instance` and `destroy_instance` are stubbed in state machine — Phase 2 implements
- [ ] Trade escrow `OwnerType` exists in ENUM — Phase 2 implements trade sessions


---

## CONVERSATION CROSS-CHECK

The following items were verified against the full design conversation before this guide was finalized.

### Confirmed present
- [x] 6-second tick, server-authoritative, worker thread isolated from I/O
- [x] Tick drift: graceful warning to admin, system continues
- [x] Session grace: 10 ticks on disconnect, then ghost fallback (permission-based, no separate code path)
- [x] Any user type can act as a lower type (TYPE_RANK downgrade in permission resolver)
- [x] Ghost = read-only, enforced in permission resolver not separately
- [x] WebSocket, ws library, no Socket.io
- [x] Redis hot state + Postgres source of truth. AOF referenced in sync.js notes.
- [x] On crash: recover to known-good Postgres state, do not attempt mid-tick reconciliation
- [x] Configurable script budgets (maxTransitions, maxEvents) on Script record and global config
- [x] Permission levels: owned_by, granted, denied. Resolution order correct.
- [x] Explicit DENIED always wins
- [x] User DB owned by root. All permission changes logged to PermissionLog (append-only).
- [x] Low-level machine state actions generate audit logs (logger.audit, category STATE_MACHINE/PERMISSION/OWNERSHIP)
- [x] Object permissions tied to object itself, not possessor
- [x] Power users edit within template. Schema changes = admin/root only (noted as enforcement responsibility in Phase 2).
- [x] No stacked conditions. Discrete named entries. Chains authored in scripts.
- [x] Rolls 0-99, seeded per session (xoshiro128ss), ungated actions return 'ungated' not a fail
- [x] Base probability 20-40%: roll engine makes no assumptions; target numbers set by Phase 2
- [x] Degrees of success: strong (tens less), weak (tens equal, ones less), fail
- [x] Opposed: lower roll wins, tie goes to defender
- [x] is_state generic replaces all specific booleans (is_open, is_locked, etc.)
- [x] on_event generic trigger in vocabulary
- [x] DSL: on {trigger} [if {condition}] do {action}. Stored as JSON, never raw text.
- [x] Script execution: state machine, not general code. Constrained action vocabulary.
- [x] Scripts inherit permissions of attached object, not triggering character
- [x] Local variables (vars {}) are scratch space, discarded after tick. Persistent state in isState/state.
- [x] Spawning via story script (create_instance action), not a separate spawn manager
- [x] Day/night: configurable per region, world-level default (defaultWorldDayTicks in config)
- [x] World clock: global tick counter + per-region day cycle in tickClocks()
- [x] Object hierarchy: User namespace (→ avatars → home) parallel to World (→ regions → locations)
- [x] Factory objects: templates + instances. Templates world-level, instances region-namespaced.
- [x] Object type ENUM includes COIN. Coin has count field on ObjectInstance.
- [x] Coin is an object (weight-bearing). Coin purse = container instance carrying coin instances.
- [x] Aliases in User record (JSON), Avatar record (JSON), Location/Region schema (JSON fields)
- [x] Command aliases in command registry (aliasMap). User-level aliases resolved in router before dispatch.
- [x] Message inbox within User record (inboxLimit field). Messages table with sane size default.
- [x] Weight as integer. carryCapacity and encumberedThreshold on Avatar.
- [x] Container ownership: OwnerType.CONTAINER for instance-in-instance. owner_type flexible string.
- [x] Escrow: OwnerType.ESCROW stub for Phase 2 trade.
- [x] Vendor in ObjectType ENUM.
- [x] Phase 1 tick cost = 1 for all low-level mechanics. Phase 2 configures higher costs.
- [x] Command dispatch table (registry Map) accepts dynamic registration — Phase 2 calls registerCommand.
- [x] VALID_TRIGGERS, VALID_CONDITION_FNS, VALID_ACTION_FNS are Sets — Phase 2 can .add() to them.
- [x] Every schema table has metadata Json? column.
- [x] Every ENUM has EXTENDED value.
- [x] Region config is a JSON column with a defined shape but no enforcement — Phase 2 adds keys freely.
- [x] avatar.stats and avatar.skills are schema-free JSON. Phase 2 defines named fields.
- [x] World-alive principle: builders seed templates and events, engine animates without intervention.
- [x] Terminal aesthetic: dark bg, monospace font, scrollback, status bar, command input.
- [x] Simple enough for wide device support. Mobile possible but not a constraint.
- [x] Client: vanilla JS, no framework, no client-side game logic.
- [x] Format tags: [b][i][dim][color=x][/]. Bracket notation avoids # sigil collision.
- [x] Color whitelist: red green blue yellow cyan magenta white gray.
- [x] Server sanitizes all output before emit. Client renders pre-sanitized HTML only.
- [x] Scrollback with user-scroll detection (pause auto-scroll when user scrolls up).
- [x] Command history: up/down arrow keys, 50-entry client-side buffer.
- [x] Autocomplete stub in place. Phase 2 populates.
- [x] /login handled client-side before sending to server (password not echoed in output).
- [x] Admin alerts delivered to all ADMIN+ sessions via handleWorkerMessage.
- [x] Building noted as possible via server/schema — builder command vocabulary is Phase 2.
- [x] Loot table JSON on ObjectTemplate. Structure defined: [{ templateId, quantity, dropChance }].
- [x] Recipe schema noted as Phase 3 — Phase 1 leaves metadata Json? on relevant tables as extension point.
- [x] Character creation: Phase 1 provides the schema. Actual creation flow (name, region, defaults) is Phase 2.
- [x] Skill/condition/spell definitions live at world level, region-gated via permission system.
- [x] Phase 1 stat model: generic stats JSON on avatar. No named stats. Phase 2 defines names.
- [x] Gated minimum value for rolls: targetNumber param in resolve(). null = ungated.
- [x] Conflict arbitration: priority order defined. Random tiebreak within priority. Single arbitration module.

### Items intentionally deferred to Phase 2
- Password hashing (bcrypt) — Phase 1 uses placeholder comparison, noted in code comment
- Full avatar creation flow and starting stat defaults
- Named stats (body/mind/reflex/presence or equivalent)
- Skill definitions and progression implementation
- Wound severity tiers
- Combat command implementation
- Trade session implementation (escrow type stubbed)
- Builder command vocabulary
- Autocomplete command list
- Container open/close commands (isState["open"] backing is in Phase 1)
- Death state enforcement logic
- PvP consent model
- Flee mechanic
- Recipe and crafting commands
- Economy and vendor interaction

