import { db } from '../db/postgres.js';
import { logger } from '../log/logger.js';

// Resolution order:
// 1. Explicit DENIED wins always
// 2. Explicit GRANTED
// 3. OWNED_BY
// 4. User-type default
// 5. Reject

const TYPE_DEFAULTS = {
  ROOT:       { level: 'OWNED_BY', scope: 'world' },
  ADMIN:      { level: 'GRANTED',  scope: 'all_regions' },
  POWER_USER: { level: 'GRANTED',  scope: 'assigned_regions' },
  CHARACTER:  { level: 'OWNED_BY', scope: 'self_and_home' },
  GHOST:      { level: 'GRANTED',  scope: 'read_only' },
};

const TYPE_RANK = { ROOT: 5, ADMIN: 4, POWER_USER: 3, CHARACTER: 2, GHOST: 1 };

/**
 * Check whether a subject has permission to perform an action on a target.
 *
 * @param {object} subject  - { userId, userType, avatarId? }
 * @param {string} action   - e.g. 'write', 'read', 'execute', 'delete'
 * @param {object} target   - { type: 'region'|'location'|'object_template'|..., id: string }
 * @param {object} opts     - { actingAs?: UserType }
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
export async function checkPermission(subject, action, target, opts = {}) {
  const effectiveType = opts.actingAs
    ? (TYPE_RANK[opts.actingAs] <= TYPE_RANK[subject.userType] ? opts.actingAs : subject.userType)
    : subject.userType;

  if (effectiveType === 'ROOT') {
    return { allowed: true, reason: 'root' };
  }

  if (effectiveType === 'GHOST' && action !== 'read') {
    return { allowed: false, reason: 'ghost_readonly' };
  }

  const rows = await db.permission.findMany({
    where: {
      OR: [
        { subjectType: 'user',      subjectId: String(subject.userId) },
        { subjectType: 'user_type', subjectId: effectiveType },
        ...(subject.avatarId ? [{ subjectType: 'avatar', subjectId: String(subject.avatarId) }] : []),
      ],
      objectType: target.type,
      objectId: { in: [String(target.id), '*'] },
    },
  });

  const denied = rows.find(r => r.level === 'DENIED');
  if (denied) {
    logger.audit('PERMISSION', 'check_denied', { subject, action, target });
    return { allowed: false, reason: 'explicit_denied' };
  }

  const granted = rows.find(r => r.level === 'GRANTED');
  if (granted) return { allowed: true, reason: 'explicit_granted' };

  const owned = rows.find(r => r.level === 'OWNED_BY');
  if (owned) return { allowed: true, reason: 'owned_by' };

  const def = TYPE_DEFAULTS[effectiveType];
  if (def) {
    if (def.scope === 'all_regions') return { allowed: true, reason: 'type_default_admin' };
    if (def.scope === 'read_only' && action === 'read') return { allowed: true, reason: 'type_default_ghost' };
  }

  return { allowed: false, reason: 'no_permission' };
}

/**
 * Grant, deny, or revoke a permission. Always logs.
 */
export async function setPermission({ actorUserId, subjectType, subjectId, objectType, objectId, level }) {
  const existing = await db.permission.findFirst({
    where: { subjectType, subjectId: String(subjectId), objectType, objectId: String(objectId) },
  });

  if (existing) {
    await db.permission.update({ where: { id: existing.id }, data: { level, grantedBy: actorUserId } });
  } else {
    await db.permission.create({
      data: { subjectType, subjectId: String(subjectId), objectType, objectId: String(objectId), level, grantedBy: actorUserId },
    });
  }

  await db.permissionLog.create({
    data: {
      actorUserId,
      action: level === 'GRANTED' ? 'grant' : level === 'DENIED' ? 'deny' : 'revoke',
      subjectType,
      subjectId: String(subjectId),
      objectType,
      objectId: String(objectId),
      level,
    },
  });

  logger.audit('PERMISSION', 'set', { actorUserId, subjectType, subjectId, objectType, objectId, level });
}
