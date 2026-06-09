// Orders a phase's actions into deterministic resolution sequence.
// Rolls are drawn HERE (resolution time), against start-of-phase snapshot.
// EVERY action draws a roll, even uncontested/no-skill ones: resolve(token, null)
// returns { outcome: 'ungated', roll }. The roll orders contested claims; for an
// ungated action it never causes failure.

const CATEGORY_PRIORITY = { combat: 4, movement: 3, inventory: 2, communication: 1, other: 0 };

/**
 * @param actions  drained actions for one phase
 * @param rollFor  async (action) => { outcome, roll }
 *                 Always returns a roll. Gated: computes target from snapshot and calls
 *                 resolve/resolveOpposed. Ungated: resolve(token, null) → {outcome:'ungated', roll}.
 * Returns ordered list: [{ action, result }] in apply order (successes+ungated asc roll, then failures).
 */
export async function orderPhase(actions, rollFor) {
  // Group by resourceKey (null = its own singleton group)
  const groups = new Map();
  actions.forEach((a, i) => {
    const key = a.resourceKey ?? `__solo_${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ a, enqueueIdx: i });
  });

  const ordered = [];
  for (const group of groups.values()) {
    const rolled = [];
    for (const g of group) rolled.push({ ...g, result: await rollFor(g.a) });

    // Gated failures claim nothing. Everything else (gated success + ungated) orders by roll.
    const failures  = rolled.filter(r => r.result.outcome === 'fail');
    const claimants = rolled.filter(r => r.result.outcome !== 'fail');

    claimants.sort((x, y) => {
      if (x.result.roll !== y.result.roll) return x.result.roll - y.result.roll; // ascending roll
      const px = CATEGORY_PRIORITY[x.a.category] ?? 0;
      const py = CATEGORY_PRIORITY[y.a.category] ?? 0;
      if (px !== py) return py - px;                                              // category tiebreak
      return x.enqueueIdx - y.enqueueIdx;                                         // FIFO tiebreak
    });

    for (const r of [...claimants, ...failures]) {
      ordered.push({ action: r.a, result: r.result });
    }
  }
  return ordered;
}
