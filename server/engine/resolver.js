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
 *   no target → ungated
 */
export function resolve(sessionToken, targetNumber) {
  const r = roll(sessionToken);

  if (targetNumber === null || targetNumber === undefined) {
    return { outcome: 'ungated', roll: r, target: null };
  }

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

  if (aResult.outcome === 'fail' && dResult.outcome === 'fail') {
    return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
  }
  if (aResult.outcome === 'fail') return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
  if (dResult.outcome === 'fail') return { winner: 'attacker', attackerResult: aResult, defenderResult: dResult };

  if (aResult.roll < dResult.roll) return { winner: 'attacker', attackerResult: aResult, defenderResult: dResult };
  return { winner: 'defender', attackerResult: aResult, defenderResult: dResult };
}
