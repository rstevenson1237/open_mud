import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';

const GROUP_ORDER = ['system', 'navigation', 'combat', 'communication', 'inventory', 'economy', 'character', 'world', 'admin', 'root'];
const GROUP_LABELS = {
  system: 'SYSTEM', navigation: 'NAVIGATION', combat: 'COMBAT',
  communication: 'COMMUNICATION', inventory: 'INVENTORY', economy: 'ECONOMY',
  character: 'CHARACTER', world: 'WORLD', admin: 'ADMIN', root: 'ROOT',
};

export function registerBuiltins() {
  // /help — list available commands filtered by caller's permission level
  registerCommand('/help', async (ctx) => {
    const { listCommands } = await import('./commands.js');
    const effective = ctx.userType;
    const cmds = listCommands({ effectiveType: effective });

    // Group commands
    const groups = {};
    for (const c of cmds) {
      const g = c.group || 'other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    }

    const lines = [];
    const ordered = [...GROUP_ORDER, ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g))];
    for (const key of ordered) {
      if (!groups[key]) continue;
      const label = (GROUP_LABELS[key] ?? key.toUpperCase()).padEnd(13);
      const verbList = groups[key].map(c => {
        const shortAliases = c.aliases.filter(a => !a.startsWith('/') && a.length <= 4).slice(0, 3);
        return c.verb + (shortAliases.length ? ` (${shortAliases.join('/')})` : '');
      }).join(', ');
      lines.push(`<strong>${label}</strong> ${escHtml(verbList)}`);
    }

    const header = `<strong>Commands</strong> <span class="dim">— ${effective}</span>`;
    return { output: header + '<br>' + lines.join('<br>') };
  }, {
    aliases: ['/?', 'help'],
    minUserType: 'GHOST',
    group: 'system',
    description: 'List available commands',
  });

  // /whoami — show current session info
  registerCommand('/whoami', async (ctx) => {
    return { output: renderOutput(`[b]User:[/] ${ctx.userId} [b]Type:[/] ${ctx.userType} [b]Avatar:[/] ${ctx.avatarId ?? 'none'}`) };
  }, {
    aliases: [],
    minUserType: 'GHOST',
    group: 'system',
    description: 'Show your session info',
  });

  // /ping — latency test
  registerCommand('/ping', async (ctx) => {
    return { output: renderOutput('[dim]pong[/]') };
  }, {
    minUserType: 'GHOST',
    group: 'system',
    description: 'Latency test',
  });
}

function escHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
