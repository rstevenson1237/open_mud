import { db } from '../db/postgres.js';
import { getStatModifier } from './conditions.js';

// Nine stats: three majors × three minors (Force/Precision/Resistance)
export const STAT_KEYS = [
  'phy_for', 'phy_pre', 'phy_res',
  'men_for', 'men_pre', 'men_res',
  'soc_for', 'soc_pre', 'soc_res',
];

const MAJORS = {
  Physical: ['phy_for', 'phy_pre', 'phy_res'],
  Mental:   ['men_for', 'men_pre', 'men_res'],
  Social:   ['soc_for', 'soc_pre', 'soc_res'],
};

const STAT_BASELINE = 20;

/**
 * Return the default 9-stat JSON for a new avatar.
 * All stats start at baseline 20.
 */
export function defaultStats() {
  return Object.fromEntries(
    STAT_KEYS.map(k => [k, { value: STAT_BASELINE, metadata: {} }])
  );
}

/**
 * Apply a point-buy allocation to a stats object.
 * Allocation: { phy_for: N, phy_pre: N, ... } — points above baseline, each ≥ 0.
 * Validates:
 *   1. Total allocation across all stats ≤ majorBudget.
 *   2. Per-major allocation (Physical/Mental/Social) ≤ minorBudgetPerMajor.
 *   3. Each final stat value in [statMin, statMax].
 * Returns { ok: true, stats } on success or { ok: false, reason } on failure.
 */
export function applyPointBuy(stats, allocation, {
  majorBudget = 30,
  minorBudgetPerMajor = 20,
  statMin = 0,
  statMax = 40,
} = {}) {
  // Validate and normalize allocation — only known stat keys, values non-negative integers
  const alloc = {};
  for (const key of STAT_KEYS) {
    const v = allocation[key] ?? 0;
    if (!Number.isInteger(v) || v < 0) {
      return { ok: false, reason: `Allocation for ${key} must be a non-negative integer.` };
    }
    alloc[key] = v;
  }

  // Check per-major budget
  for (const [majorName, keys] of Object.entries(MAJORS)) {
    const majorTotal = keys.reduce((sum, k) => sum + alloc[k], 0);
    if (majorTotal > minorBudgetPerMajor) {
      return { ok: false, reason: `${majorName} allocation (${majorTotal}) exceeds minor budget per major (${minorBudgetPerMajor}).` };
    }
  }

  // Check grand total budget
  const grandTotal = STAT_KEYS.reduce((sum, k) => sum + alloc[k], 0);
  if (grandTotal > majorBudget) {
    return { ok: false, reason: `Total allocation (${grandTotal}) exceeds major budget (${majorBudget}).` };
  }

  // Build new stats and check per-stat bounds
  const newStats = {};
  for (const key of STAT_KEYS) {
    const newValue = (stats[key]?.value ?? STAT_BASELINE) + alloc[key];
    if (newValue < statMin) return { ok: false, reason: `${key} would fall below statMin (${statMin}).` };
    if (newValue > statMax) return { ok: false, reason: `${key} would exceed statMax (${statMax}).` };
    newStats[key] = { value: newValue, metadata: stats[key]?.metadata ?? {} };
  }

  return { ok: true, stats: newStats };
}

/**
 * Stat contribution to a roll target (capped at 40 regardless of raw value).
 */
export function statContribution(value) {
  return Math.min(value, 40);
}

/**
 * Compute the roll target for an action.
 * target = statContribution(statValue) + skillRollContribution + conditionModifier
 * Hard cap at 70.
 *
 * @param {object} entity            Avatar or mob instance with stats and activeConditions.
 * @param {string} statKey           e.g. 'phy_for'
 * @param {number|null} skillId      SkillDefinition id (null = no skill gate)
 * @param {string|null} conditionTargetStat  Stat name for condition modifier lookup
 *                                   (defaults to statKey; use when multiple stats are affected)
 */
export async function getRollTarget(entity, statKey, skillId = null, conditionTargetStat = null) {
  const statValue = entity.stats?.[statKey]?.value ?? STAT_BASELINE;
  const skillContrib = await getSkillRollContribution(entity, skillId);
  const condMod = getStatModifier(entity, conditionTargetStat ?? statKey);
  return Math.min(statContribution(statValue) + skillContrib + condMod, 70);
}

/**
 * Return the rollContribution of a skill for an entity.
 * 0 if skillId is null, entity doesn't have the skill, or SkillDefinition isn't seeded yet.
 */
export async function getSkillRollContribution(entity, skillId) {
  if (skillId == null) return 0;
  // Check entity has the skill acquired
  const skillEntry = entity.skills?.[String(skillId)];
  if (!skillEntry?.acquired) return 0;
  try {
    const def = await db.skillDefinition.findUnique({ where: { id: skillId } });
    return def?.rollContribution ?? 0;
  } catch {
    // SkillDefinition table not yet migrated (pre-TASK 2)
    return 0;
  }
}

/**
 * Read the active budgets for point-buy from world config,
 * optionally overridden by a region's creation config.
 * Used by character creation (TASK 5).
 */
export async function getPointBuyConfig(regionConfig = null) {
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const wCfg = world?.config ?? {};
  const rCreate = regionConfig?.creation ?? {};
  return {
    majorBudget:       rCreate.majorBudget       ?? wCfg.majorBudget       ?? 30,
    minorBudgetPerMajor: rCreate.minorBudgetPerMajor ?? wCfg.minorBudgetPerMajor ?? 20,
    statMin:           rCreate.statMin           ?? 0,
    statMax:           rCreate.statMax           ?? 40,
  };
}
