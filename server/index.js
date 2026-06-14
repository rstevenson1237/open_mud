import { Worker } from 'worker_threads';
import { config } from './config.js';
import { initDb } from './db/postgres.js';
import { initRedis } from './db/redis.js';
import { startWsServer, handleWorkerMessage } from './ws/server.js';
import { registerBuiltins } from './interface/builtins.js';
import { register as registerCreation } from './interface/cmd_creation.js';
import { register as registerNavigation } from './interface/cmd_navigation.js';
import { register as registerCommunication } from './interface/cmd_communication.js';
import { register as registerInventory } from './interface/cmd_inventory.js';
import { register as registerCombat } from './interface/cmd_combat.js';
import { register as registerBuilder } from './interface/cmd_builder.js';
import { register as registerEconomy } from './interface/cmd_economy.js';
import { register as registerAdmin } from './interface/cmd_admin.js';
import { register as registerAccount } from './interface/cmd_account.js';
import { register as registerCrafting } from './interface/cmd_crafting.js';
import { register as registerQuests } from './interface/cmd_quest.js';
import { registerPanelHandlers } from './interface/panels.js';
import { logger } from './log/logger.js';

async function main() {
  logger.info('SERVER', 'Starting MUD engine');

  await initDb();
  await initRedis();
  registerBuiltins();

  // ─── REGISTRATION-SITE RULE ────────────────────────────────────────────────
  // This file (main thread) registers COMMAND MODULES only via register().
  // registerSystemHandler and registerMaintenanceTask belong in server/tick/engine.js
  // (the worker thread). Never call those functions here.
  // ───────────────────────────────────────────────────────────────────────────

  // Phase 2 command registrations (order matters for alias resolution)
  registerCreation();
  registerNavigation();
  registerCommunication();
  registerInventory();
  registerCombat();
  registerBuilder();
  registerEconomy();
  registerAdmin();
  registerAccount();
  registerCrafting();
  registerQuests();
  registerPanelHandlers();

  const { sessions } = startWsServer(config.port);

  const tickWorker = new Worker(new URL('./tick/engine.js', import.meta.url));
  tickWorker.on('message', (msg) => handleWorkerMessage(msg, sessions));
  tickWorker.on('error',   (e)   => logger.error('SERVER', 'Tick worker error', { error: e.message }));
  tickWorker.on('exit',    (code) => {
    if (code !== 0) logger.error('SERVER', 'Tick worker exited unexpectedly', { code });
  });

  logger.info('SERVER', `MUD engine running on port ${config.port}`);
}

main().catch(e => {
  logger.error('SERVER', 'Fatal startup error', { error: e.message, stack: e.stack });
  process.exit(1);
});
