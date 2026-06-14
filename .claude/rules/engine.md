# Engine — DSL Vocabulary & State Machine Rules

## DSL Syntax

```
on_{trigger}[(args)] [if condition_fn(args)] do action_fn(args) [do action_fn(args)]
// comment — stripped before parsing
```

String types inside DSL arguments:
- `"text"` — formatted string, substitutions resolved
- `'text'` — literal string, no substitution

Sigils (resolved by router before DSL execution):
- `@name` or `@0042` — user reference
- `$name` or `$0042` — object/mob reference (region-namespaced)
- `#name` or `#0042` — location/region/exit/portal reference
- `/command` — system command or escape
- `//` — comment

Format tags (inside output strings only — never in sigil position):
- `[b]`, `[i]`, `[dim]`, `[color=red]`, `[/]`
- Color whitelist: red green blue yellow cyan magenta white gray

## Phase 1 Trigger Vocabulary

```
on_enter            on_exit             on_use
on_tick             on_say              on_give
on_take             on_attack           on_death
on_time(N)          on_condition_apply  on_condition_expire
on_event(name)
```

Phase 2 adds triggers via: `VALID_TRIGGERS.add('trigger_name')` in parser.js

## Phase 3 Trigger Vocabulary (added via `.add()`)

```
on_craft           on_quest_accept     on_quest_complete
on_harvest         on_respawn
```

## Phase 1 Condition Vocabulary

```
has_condition(name)         is_state(key, value)
stat_above(name, value)     stat_below(name, value)
has_item(template_id)       in_state(name)
user_type_is(type)          zone_is(type)
random_under(N)
```

Phase 2 adds via: `VALID_CONDITION_FNS.add('fn_name')` in parser.js

## Phase 3 Condition Vocabulary (added via `.add()`)

```
has_quest(questId, status)     -- true if avatar.quests[id].status === status
```

## Phase 1 Action Vocabulary

```
say(text)                   move(exit_id)
give(instance_id, target)   take(instance_id)
set_state(key, value)       apply_condition(name, duration_ticks)
remove_condition(name)      emit_event(name, target)
lock()                      unlock()
enqueue(action, ticks)      resolve_roll(stat)
set_var(name, value)        if_success(action)
if_fail(action)             create_instance(template_id, location_id)
destroy_instance(instance_id)
```

Phase 2 adds via: `VALID_ACTION_FNS.add('fn_name')` in parser.js
`create_instance` and `destroy_instance` are **fully implemented in Phase 3** (no longer stubs).

## Phase 3 Action Vocabulary (added via `.add()`)

```
grant_quest(avatarId, questId)       -- start quest progress on an avatar
complete_quest(avatarId, questId)    -- dispatch rewards; sets turned_in
```

## Script Execution Rules

1. Rules evaluated in declaration order. First matching trigger + condition wins.
2. Budget enforced per object per tick: maxTransitions (default 32), maxEvents (default 8).
3. Budget overridable per script via `Script.maxTransitions` and `Script.maxEvents` fields.
4. Budget exceeded → halt that object's script for the tick, log a warning.
5. Local vars (`vars {}`) are scratch only — discarded after the tick run.
6. Persistent state → write to `isState` or `state` on the instance.
7. Scripts never exceed the permissions of their attached object.

## World-Alive Principle

The engine animates the world without direct human intervention.
Builders seed: object templates, condition definitions, story scripts, event chains.
The tick loop, state machines, and condition engine do the rest.

Spawn pattern (correct):
```
// In a region-level story script:
on_death if in_state("goblin_king_dead") do enqueue(create_instance($goblin_king_tmpl, #throne_room), 100)
```

Spawn pattern (wrong — no separate spawn manager exists):
```
// Do NOT create a SpawnManager class or spawn table schema
```

## Output Format

Server emits pre-sanitized HTML to clients. Never emit raw user input as HTML.
Format tag rendering is done in `server/interface/output.js` by `renderOutput()`.
Status payloads are separate JSON messages (`{ type: 'STATUS', data: {...} }`).
Two WebSocket message types from server: `OUTPUT` (html string) and `STATUS` (JSON).
One message type from client: `CMD` (raw input string). Plus `AUTH` on login.
