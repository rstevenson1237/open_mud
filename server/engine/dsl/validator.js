// Validates a parsed DSL JSON body (Script.body) before persistence.
// Phase 2 extends validation rules as new triggers/actions are registered.

/**
 * Validate a parsed script body array.
 * @param {Array} body  Output of parseDSL().body
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBody(body) {
  const errors = [];

  if (!Array.isArray(body)) {
    return { ok: false, errors: ['Script body must be an array'] };
  }

  for (let i = 0; i < body.length; i++) {
    const rule = body[i];
    if (!rule.trigger)            errors.push(`Rule ${i}: missing trigger`);
    if (!Array.isArray(rule.conditions)) errors.push(`Rule ${i}: conditions must be an array`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      errors.push(`Rule ${i}: must have at least one action`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}
