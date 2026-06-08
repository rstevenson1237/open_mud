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
  'call',           // call(subroutine_name)
  'apply_wound',    // stub — Phase 2 implements
  'apply_sanity',   // stub — Phase 2 implements
  'grant_skill',    // stub — Phase 2 implements
  'revoke_skill',   // stub — Phase 2 implements
  'set_stance',     // stub — Phase 2 implements
  'action_run',     // stub — Phase 2 implements
  'attack_target',  // stub — Phase 2 implements
  'end_combat',     // stub — Phase 2 implements
]);

/**
 * Parse DSL source text into structured JSON.
 *
 * DSL format:
 *   on_enter do say("Welcome.")
 *   on_enter if has_condition("locked") do say("The door is locked.")
 *   on_tick do emit_event("patrol_step", "#region")
 *
 * Returns: { ok: true, body: [...] } | { ok: false, errors: [...] }
 */
export function parseDSL(source) {
  const lines = source
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//'));

  const subroutines = {};
  const topLevelRules = [];
  const errors = [];

  let currentSubroutine = null;

  for (const line of lines) {
    // Subroutine declaration: { name }
    const subMatch = line.match(/^\{\s*(\w+)\s*\}$/);
    if (subMatch) {
      currentSubroutine = subMatch[1];
      subroutines[currentSubroutine] = [];
      continue;
    }

    // End of subroutine block: standalone . on its own line
    if (line === '.') {
      currentSubroutine = null;
      continue;
    }

    const result = _parseLine(line);
    if (result.error) {
      errors.push(result.error);
    } else {
      if (currentSubroutine) {
        subroutines[currentSubroutine].push(result.rule);
      } else {
        topLevelRules.push(result.rule);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, body: { rules: topLevelRules, subroutines } };
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
  const args = [];
  const regex = /"([^"]*?)"|'([^']*?)'|([^,\s]+)/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}
