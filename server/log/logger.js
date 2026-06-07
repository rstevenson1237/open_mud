const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 1;

function log(level, category, message, data = {}) {
  if (LEVELS[level] < current) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    ...data,
  };
  const forced = category === 'PERMISSION' || category === 'OWNERSHIP' || category === 'STATE_MACHINE';
  if (forced || LEVELS[level] >= current) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

export const logger = {
  debug: (cat, msg, data) => log('debug', cat, msg, data),
  info:  (cat, msg, data) => log('info',  cat, msg, data),
  warn:  (cat, msg, data) => log('warn',  cat, msg, data),
  error: (cat, msg, data) => log('error', cat, msg, data),
  audit: (cat, msg, data) => log('info', cat, msg, { ...data, _audit: true }),
};
