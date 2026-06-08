import { Worker } from 'worker_threads';
import { config } from './config.js';
import { initDb } from './db/postgres.js';
import { initRedis } from './db/redis.js';
import { startWsServer, handleWorkerMessage } from './ws/server.js';
import { registerBuiltins } from './interface/builtins.js';
import { register as registerCreation } from './interface/cmd_creation.js';
import { register as registerNavigation } from './interface/cmd_navigation.js';
import { register as registerCommunication } from './interface/cmd_communication.js';
import { logger } from './log/logger.js';

async function main() {
  logger.info('SERVER', 'Starting MUD engine');

  await initDb();
  await initRedis();
  registerBuiltins();

  // Phase 2 command registrations (order matters for alias resolution)
  registerCreation();
  registerNavigation();
  registerCommunication();

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
