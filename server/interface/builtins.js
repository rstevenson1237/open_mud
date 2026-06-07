import { registerCommand } from './commands.js';
import { renderOutput } from './output.js';

export function registerBuiltins() {
  // /help — list available commands
  registerCommand('/help', async (ctx) => {
    const { listCommands } = await import('./commands.js');
    const cmds = listCommands().map(c => c.verb).join(', ');
    return { output: renderOutput(`[b]Available commands:[/] ${cmds}`) };
  }, { aliases: ['/?'], minUserType: 'GHOST' });

  // /whoami — show current session info
  registerCommand('/whoami', async (ctx) => {
    return { output: renderOutput(`[b]User:[/] ${ctx.userId} [b]Type:[/] ${ctx.userType} [b]Avatar:[/] ${ctx.avatarId ?? 'none'}`) };
  }, { aliases: [], minUserType: 'GHOST' });

  // /ping — latency test
  registerCommand('/ping', async (ctx) => {
    return { output: renderOutput('[dim]pong[/]') };
  }, { minUserType: 'GHOST' });
}
