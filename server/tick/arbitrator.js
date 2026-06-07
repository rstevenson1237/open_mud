// Conflict resolution logic extracted for unit testing by Phase 2.
// The tick engine (engine.js) contains the live arbitrate() function;
// this module re-exports it for external use once Phase 2 wires it up.

export const PRIORITY = { combat: 4, movement: 3, inventory: 2, communication: 1 };
