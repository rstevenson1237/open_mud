// Command registry — Phase 2 registers commands here without modifying this file.
const registry = new Map();  // verb → { handler, aliases, tickCost, minUserType, description, group }
const aliasMap  = new Map();  // alias → canonical verb

const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };

/**
 * Register a command handler.
 * @param {string}   verb         Primary command name
 * @param {Function} handler      async (context) => { output: string, status?: object }
 * @param {object}   opts
 *   aliases      string[]    Additional names that map to this command
 *   tickCost     number      Default 1
 *   minUserType  string      Minimum user type required
 *   description  string      One-line description shown in /help
 *   group        string      Category label: system|navigation|combat|communication|inventory|economy|character|world|admin|root
 */
export function registerCommand(verb, handler, opts = {}) {
  const entry = {
    verb,
    handler,
    aliases: opts.aliases ?? [],
    tickCost: opts.tickCost ?? 1,
    minUserType: opts.minUserType ?? 'CHARACTER',
    description: opts.description ?? '',
    group: opts.group ?? '',
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

/**
 * List commands, optionally filtered by the caller's effective user type.
 * @param {object} opts
 *   effectiveType  string   If provided, only return commands the caller can use
 */
export function listCommands(opts = {}) {
  const entries = [...registry.values()];
  const filtered = opts.effectiveType
    ? entries.filter(e => TYPE_RANK[opts.effectiveType] >= TYPE_RANK[e.minUserType ?? 'CHARACTER'])
    : entries;
  return filtered.map(e => ({
    verb: e.verb,
    aliases: e.aliases,
    group: e.group,
    description: e.description,
    minUserType: e.minUserType,
  }));
}
