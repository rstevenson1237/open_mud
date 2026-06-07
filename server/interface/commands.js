// Command registry — Phase 2 registers commands here without modifying this file.
const registry = new Map();  // verb → { handler, aliases, tickCost, minUserType }
const aliasMap  = new Map();  // alias → canonical verb

/**
 * Register a command handler.
 * @param {string}   verb         Primary command name
 * @param {Function} handler      async (context) => { output: string, status?: object }
 * @param {object}   opts
 *   aliases      string[]    Additional names that map to this command
 *   tickCost     number      Default 1
 *   minUserType  string      Minimum user type required
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
