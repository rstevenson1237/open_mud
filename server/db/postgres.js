import { PrismaClient } from '@prisma/client';
import { logger } from '../log/logger.js';

export const db = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

db.$on('error', (e) => logger.error('DB', 'Prisma error', { message: e.message }));
db.$on('warn',  (e) => logger.warn('DB', 'Prisma warning', { message: e.message }));

export async function initDb() {
  await db.$connect();
  await db.worldState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, tickCount: 0n },
  });
  logger.info('DB', 'Postgres connected');
}
