import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '3000'),
  tickMs: parseInt(process.env.TICK_MS ?? '6000'),
  tickDriftWarnMs: parseInt(process.env.TICK_DRIFT_WARN_MS ?? '500'),
  sessionGraceTicks: parseInt(process.env.SESSION_GRACE_TICKS ?? '10'),
  scriptMaxTransitions: parseInt(process.env.SCRIPT_MAX_TRANSITIONS ?? '32'),
  scriptMaxEvents: parseInt(process.env.SCRIPT_MAX_EVENTS ?? '8'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  databaseUrl: process.env.DATABASE_URL,
  dbFlushIntervalTicks: parseInt(process.env.DB_FLUSH_INTERVAL_TICKS ?? '10'),
  instanceArchiveAfterTicks: parseInt(process.env.INSTANCE_ARCHIVE_TICKS ?? '100'),
  defaultWorldDayTicks: parseInt(process.env.WORLD_DAY_TICKS ?? '100'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  maxResponseEventsPerTick: parseInt(process.env.MAX_RESPONSE_EVENTS_PER_TICK ?? '64'),
};
