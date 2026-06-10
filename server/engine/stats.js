import { db } from '../db/postgres.js';
import { getStatModifier } from './conditions.js';

// Nine stats: three majors × three minors (Force/Precision/Resistance)
export const STAT_KEYS = [
  'phy_for', 'phy_pre', 'phy_res',
  'men_for', 'men_pre', 'men_res',
  'soc_for', 'soc_pre', 'soc_res',
];

export const MAJORS = {
  Physical: ['phy_for', 'phy_pre', 'phy_res'],
  Mental:   ['men_for', 'men_pre', 'men_res'],
  Social:   ['soc_for', 'soc_pre', 'soc_res'],
};

// Maps major names to their minor stat keys for skill applicability checks
export const MAJOR_TO_STATS = {
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
 * Apply final stat values to a stats object.
 * finalValues: { phy_for: N, ... } — the desired final values for each stat.
 * currentStats: existing stat object (used to carry forward metadata only).
 *
 * Validation rules:
 *   1. Each stat ∈ [statMin, statMax]  (default [10, 40])
 *   2. Sum of max(0, stat − 20) across all 9 stats ≤ majorBudget (budget counts only above-baseline)
 *   3. Within each major group, sum of three stat values ≥ 60 (enforces zero-sum internal shift balance)
 *
 * The within-major free rebalancing mechanic: players can reduce one minor stat and increase
 * another in the same major 1:1 at no budget cost, up to ±10 per stat. Rule 3 enforces
 * that below-baseline reductions are covered by above-baseline peers in the same major.
 *
 * Returns { ok: true, stats } on success or { ok: false, reason } on failure.
 */
export function applyPointBuy(currentStats, finalValues, {
  majorBudget = 30,
  statMin = 10,
  statMax = 40,
} = {}) {
  // Rule 1: validate each stat is an integer in [statMin, statMax]
  for (const key of STAT_KEYS) {
    const v = finalValues[key];
    if (!Number.isInteger(v)) {
      return { ok: false, reason: `${key} must be an integer.` };
    }
    if (v < statMin) return { ok: false, reason: `${key} (${v}) is below the minimum of ${statMin}.` };
    if (v > statMax) return { ok: false, reason: `${key} (${v}) exceeds the maximum of ${statMax}.` };
  }

  // Rule 2: total points above baseline ≤ majorBudget
  const aboveBaseline = STAT_KEYS.reduce((sum, k) => sum + Math.max(0, finalValues[k] - STAT_BASELINE), 0);
  if (aboveBaseline > majorBudget) {
    return { ok: false, reason: `Total points above baseline (${aboveBaseline}) exceeds budget of ${majorBudget}.` };
  }

  // Rule 3: within each major, the sum of the three stats must be ≥ 60 (3 × baseline)
  for (const [majorName, keys] of Object.entries(MAJORS)) {
    const majorSum = keys.reduce((sum, k) => sum + finalValues[k], 0);
    if (majorSum < STAT_BASELINE * keys.length) {
      return {
        ok: false,
        reason: `${majorName} stats (${keys.map(k => finalValues[k]).join('+')}=${majorSum}) cannot net below baseline — free shifts within a major must balance out.`,
      };
    }
  }

  // Build final stat object, carrying forward any existing metadata
  const newStats = {};
  for (const key of STAT_KEYS) {
    newStats[key] = { value: finalValues[key], metadata: currentStats[key]?.metadata ?? {} };
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
  const skillContrib = await getSkillRollContribution(entity, skillId, statKey);
  const condMod = getStatModifier(entity, conditionTargetStat ?? statKey);
  return Math.min(statContribution(statValue) + skillContrib + condMod, 70);
}

/**
 * Return the rollContribution of a skill for an entity, given the stat key being rolled.
 * Handles both minor-level skills (stat = 'phy_for') and major-level skills (stat = 'Physical').
 * 0 if skillId is null, entity doesn't have the skill, skill doesn't apply to statKey, or table not seeded.
 */
export async function getSkillRollContribution(entity, skillId, statKey = null) {
  if (skillId == null) return 0;
  const skillEntry = entity.skills?.[String(skillId)];
  if (!skillEntry?.acquired) return 0;
  try {
    const def = await db.skillDefinition.findUnique({ where: { id: skillId } });
    if (!def) return 0;
    // Check skill applicability against the rolling stat
    if (statKey && def.stat) {
      const majorKeys = MAJOR_TO_STATS[def.stat];
      if (majorKeys) {
        // Major-level skill: applies to any minor in that major
        if (!majorKeys.includes(statKey)) return 0;
      } else {
        // Minor-level skill: must exactly match the rolling stat
        if (def.stat !== statKey) return 0;
      }
    }
    return def.rollContribution ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read the active budgets for point-buy from world config,
 * optionally overridden by a region's creation config.
 */
export async function getPointBuyConfig(regionConfig = null) {
  const world = await db.worldState.findUnique({ where: { id: 1 } });
  const wCfg = world?.config ?? {};
  const rCreate = regionConfig?.creation ?? {};
  return {
    majorBudget: rCreate.majorBudget ?? wCfg.majorBudget ?? 30,
    statMin:     rCreate.statMin     ?? wCfg.statMin     ?? 10,
    statMax:     rCreate.statMax     ?? wCfg.statMax     ?? 40,
  };
}
