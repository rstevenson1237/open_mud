# MUD Engine — Claude Code Context

## Project Identity

A persistent multiplayer text-based game engine (MUD) built in Node.js.
Terminal aesthetic browser client. Three-service stack: Node.js + PostgreSQL + Redis.
Single developer. All work commits directly to main. No feature branches.

## Stack

- **Runtime:** Node.js LTS (v20+) via nvm
- **Database:** PostgreSQL 15 (native apt install on Crostini)
- **Cache/Hot state:** Redis 7 (native apt install on Crostini)
- **ORM:** Prisma 5 — schema at `prisma/schema.prisma`
- **WebSocket:** `ws` library — no Socket.io
- **Client:** Vanilla JS + HTML/CSS — no framework

## Repository Layout

```
server/
  index.js          # entry point — wires worker + WS server
  config.js         # all env vars via dotenv
  tick/             # tick engine (worker thread)
    engine.js       # 6s tick loop, drift monitor, action queue drain
    queue.js        # action queue helpers
    arbitrator.js   # conflict resolution
    clock.js        # world clock / day-night
  db/
    postgres.js     # Prisma client wrapper
    redis.js        # Redis client + key conventions
    sync.js         # Redis → Postgres dirty-state flush
  engine/
    permissions.js  # SINGLE permission resolver — never duplicated
    conditions.js   # condition apply/remove/tick
    statemachine.js # state machine runner
    resolver.js     # roll engine (seeded PRNG, resolve/resolveOpposed)
    dsl/
      parser.js     # DSL text → JSON (never stores raw text)
      validator.js  # script JSON validation
  interface/
    commands.js     # command dispatch registry (dynamic registration)
    router.js       # input → command or action queue
    output.js       # output emitter + format tag renderer
    builtins.js     # Phase 1 built-in commands (/help /ping /whoami)
  ws/
    server.js       # WS server, auth, session handling
    session.js      # session state, ghost fallback
  log/
    logger.js       # structured JSON logger
client/
  index.html
  terminal.js
  terminal.css
prisma/
  schema.prisma
```

## Git Conventions

- Single developer. Commit directly to main. No feature branches.
- Commit after each completed, verified task.
- Commit messages: short imperative present tense.
  - `add avatar weight fields to schema`
  - `implement go command`
  - `fix condition expiry off-by-one`
- Never commit: `.env`, `node_modules/`, `*.log`, `prisma/migrations/` manual edits.
- Always run `npm run db:migrate` to generate migrations — never edit migration files by hand.

## Dev Session Startup (Crostini)

```bash
~/start-mud.sh     # starts Postgres + Redis if not running
cd ~/mud-engine
npm run dev        # Node server with file-watching
```

Browser: http://localhost:3000

## Commands

```bash
npm run dev              # start with file-watching
npm start                # start without watching
npm run db:migrate       # apply schema migrations (prompts for name)
npm run db:generate      # regenerate Prisma client after schema changes
```

## Environment Variables

All in `.env`. See `server/config.js` for the full list.
Critical ones: `DATABASE_URL`, `REDIS_URL`, `PORT=3000`, `TICK_MS=6000`.

## Phase Status

- **Phase 1** — Essential framework. COMPLETE + pre-Phase-2 additions applied.
  Server, DB schema, tick engine (4-phase), permission resolver, state machine,
  condition engine (with input override hook), roll engine, DSL parser
  (subroutine blocks), WS server, browser UI.
- **Phase 2** — Game interface. READY TO BEGIN.
- **Phase 3** — Content building and delivery. NOT STARTED.
- **Phase 4** — Future stubs. NOT STARTED.

Update this section as phases complete.
