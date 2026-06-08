// Region config reader with defaults.
// Region.config is open JSON; this module provides a typed view with defaults applied.

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const dv = defaults[key];
    const ov = overrides[key];
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) &&
        dv !== null && typeof dv === 'object' && !Array.isArray(dv)) {
      result[key] = deepMerge(dv, ov);
    } else if (ov !== undefined) {
      result[key] = ov;
    }
  }
  return result;
}

const DEFAULTS = {
  dayNightCycleTicks: 100,
  defaultZoneType: 'SAFE',
  deathBehavior: 'respawn_region_entry',
  sanityBreakBehavior: 'condition_only',
  sanityBreakDurationTicks: 10,
  woundMax: 3,
  sanityMax: 3,
  skillIds: [],
  conditionIds: [],
  currency: {
    base: 'coin',
    coinWeightDivisor: 100,
    denominations: [],
  },
  creation: {
    majorBudget: null,        // null → fall back to WorldState.config.majorBudget
    minorBudgetPerMajor: null, // null → fall back to WorldState.config.minorBudgetPerMajor
    statMin: 0,
    statMax: 40,
    startingSkillIds: [],
  },
  toggles: {
    combat: true,
    pvp: false,
    hunger: true,
    rest: true,
    wounds: true,
    stress: true,
    skills: true,
    crafting: false,
    story: false,
  },
};

/**
 * Return the fully-merged config for a region, applying all defaults for missing keys.
 * sanityBreakBehavior ∈ {condition_only, confusion, flee, panic, comatose, mental_break}.
 *
 * @param {object} region  Region DB row (with .config Json field)
 * @returns {object}       Merged region config
 */
export function regionCfg(region) {
  return deepMerge(DEFAULTS, region?.config ?? {});
}
