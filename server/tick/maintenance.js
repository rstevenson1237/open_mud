import { logger } from '../log/logger.js';

const tasks = [];

export function registerMaintenanceTask(name, handler) {
  tasks.push({ name, handler });
}

export async function runMaintenance(currentTick, emitEvent) {
  for (const t of tasks) {
    try {
      await t.handler(currentTick, emitEvent);
    } catch (e) {
      logger.error('MAINTENANCE', 'task failed', { task: t.name, error: e.message });
    }
  }
}
