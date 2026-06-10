// Stat key list kept local to avoid pulling in the DB layer just for a constant
const _STAT_KEYS = [
  'phy_for', 'phy_pre', 'phy_res',
  'men_for', 'men_pre', 'men_res',
  'soc_for', 'soc_pre', 'soc_res',
];

// Format tag → HTML map. Whitelist only. No other tags rendered.
const TAG_MAP = {
  'b':   ['<strong>', '</strong>'],
  'i':   ['<em>', '</em>'],
  'dim': ['<span class="dim">', '</span>'],
};
const COLOR_WHITELIST = new Set(['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'gray']);

/**
 * Convert server output string with format tags to safe HTML.
 * Format tags: [b], [i], [dim], [color=red], [/]
 */
export function renderOutput(text) {
  let html = _sanitizeBase(text);
  const stack = [];

  html = html.replace(/\[(\/?[\w=]*)\]/g, (match, tag) => {
    if (tag === '/') {
      const close = stack.pop();
      return close ?? '';
    }
    const colorMatch = tag.match(/^color=(\w+)$/);
    if (colorMatch) {
      const color = colorMatch[1];
      if (!COLOR_WHITELIST.has(color)) return '';
      stack.push('</span>');
      return `<span class="c-${color}">`;
    }
    const pair = TAG_MAP[tag];
    if (!pair) return '';
    stack.push(pair[1]);
    return pair[0];
  });

  // Close any unclosed tags
  while (stack.length > 0) html += stack.pop();
  return html;
}

/**
 * Build a STATUS payload for the client status bar.
 */
export function buildStatusPayload(avatar) {
  const stats = {};
  for (const k of _STAT_KEYS) {
    stats[k] = avatar.stats?.[k]?.value ?? 20;
  }
  return {
    type: 'STATUS',
    data: {
      name: avatar.name,
      wounds:    avatar.wounds,
      woundMax:  avatar.woundMax  ?? 3,
      sanity:    avatar.sanity,
      sanityMax: avatar.sanityMax ?? 3,
      stress:    avatar.stress,
      hunger:    avatar.hunger,
      rest:      avatar.rest,
      conditions: (avatar.activeConditions ?? [])
        .filter(c => c.visibilityEffect !== 'none')
        .map(c => c.name),
      locationName: avatar.locationName ?? '',
      zoneType:    avatar.zoneType ?? 'SAFE',
      stats,
    },
  };
}

function _sanitizeBase(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
