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
  return {
    type: 'STATUS',
    data: {
      name: avatar.name,
      wounds: avatar.wounds,
      stress: avatar.stress,
      hunger: avatar.hunger,
      rest: avatar.rest,
      conditions: (avatar.activeConditions ?? [])
        .filter(c => c.visibilityEffect !== 'none')
        .map(c => c.name),
      locationName: avatar.locationName ?? '',
      zoneType: avatar.zoneType ?? 'SAFE',
    },
  };
}

function _sanitizeBase(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
