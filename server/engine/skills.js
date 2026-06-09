import { db } from '../db/postgres.js';
import { redis } from '../db/redis.js';
import { markDirty } from '../db/sync.js';
import { logger } from '../log/logger.js';
// DSL vocab extensions (grant_skill, revoke_skill) are added in TASK 13 builder commands
// via VALID_ACTION_FNS.add() in the main thread where DSL parsing occurs.

/**
 * Grant a skill to an avatar (or instance for attachedToObject skills).
 * Checks prerequisites and region scope.
 *
 * @param {string} entityType  'avatar' | 'instance'
 * @param {string|number} entityId
 * @param {number} skillId
 * @param {object} [context]   { regionId } for region-scoped skills
 * @returns {object} { ok: true } | { ok: false, reason }
 */
export async function grantSkill(entityType, entityId, skillId, context = {}) {
  const def = await db.skillDefinition.findUnique({ where: { id: Number(skillId) } });
  if (!def) return { ok: false, reason: `Unknown skill id ${skillId}.` };

  const redisKey = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(redisKey);
  if (!raw) return { ok: false, reason: `${entityType} ${entityId} not in hot-state.` };

  const entity = JSON.parse(raw);
  const skills = _entitySkills(entity, def.attachedToObject);

  // Already acquired
  if (skills[String(skillId)]?.acquired) return { ok: true };

  // Prerequisite check
  const prereqs = Array.isArray(def.prerequisites) ? def.prerequisites : [];
  for (const prereqId of prereqs) {
    if (!skills[String(prereqId)]?.acquired) {
      const prereq = await db.skillDefinition.findUnique({ where: { id: prereqId } });
      return { ok: false, reason: `Prerequisite not met: ${prereq?.name ?? prereqId}.` };
    }
  }

  // Region scope check
  if (def.regionScoped) {
    const regionId = context.regionId;
    if (!regionId) return { ok: false, reason: `Skill ${def.name} is region-scoped but no region provided.` };
    const region = await db.region.findUnique({ where: { id: Number(regionId) } });
    const regionSkills = region?.config?.skillIds ?? [];
    if (!regionSkills.includes(Number(skillId))) {
      return { ok: false, reason: `Skill ${def.name} is not available in this region.` };
    }
  }

  // Grant
  skills[String(skillId)] = { acquired: true, metadata: {} };
  _setEntitySkills(entity, def.attachedToObject, skills);
  await redis.set(redisKey, JSON.stringify(entity));
  await markDirty(entityType, String(entityId));

  logger.audit('SKILLS', 'skill_granted', { entityType, entityId, skillId, skillName: def.name });
  return { ok: true };
}

/**
 * Revoke a skill from an avatar (or instance). Cascades to dependents.
 *
 * @param {string} entityType
 * @param {string|number} entityId
 * @param {number} skillId
 * @returns {object} { ok: true, revoked: [skillIds] } | { ok: false, reason }
 */
export async function revokeSkill(entityType, entityId, skillId) {
  const def = await db.skillDefinition.findUnique({ where: { id: Number(skillId) } });
  if (!def) return { ok: false, reason: `Unknown skill id ${skillId}.` };

  const redisKey = entityType === 'avatar' ? `avatar:${entityId}` : `instance:${entityId}`;
  const raw = await redis.get(redisKey);
  if (!raw) return { ok: false, reason: `${entityType} ${entityId} not in hot-state.` };

  const entity = JSON.parse(raw);
  const skills = _entitySkills(entity, def.attachedToObject);

  if (!skills[String(skillId)]?.acquired) return { ok: true, revoked: [] };

  // Build cascade: all skills whose prerequisites include this skillId (recursive)
  const toRevoke = new Set([Number(skillId)]);
  await _collectDependents(skills, Number(skillId), toRevoke);

  for (const rid of toRevoke) {
    delete skills[String(rid)];
    logger.audit('SKILLS', 'skill_revoked', { entityType, entityId, skillId: rid });
  }

  _setEntitySkills(entity, def.attachedToObject, skills);
  await redis.set(redisKey, JSON.stringify(entity));
  await markDirty(entityType, String(entityId));

  return { ok: true, revoked: [...toRevoke] };
}

/**
 * Recursively collect all skills acquired by the entity that depend on skillId.
 * Loads all definitions and filters in JS to avoid complex Prisma JSON queries.
 */
async function _collectDependents(entitySkills, skillId, accumulated) {
  const allDefs = await db.skillDefinition.findMany();
  for (const dep of allDefs) {
    const prereqs = Array.isArray(dep.prerequisites) ? dep.prerequisites : [];
    if (prereqs.includes(skillId) && entitySkills[String(dep.id)]?.acquired && !accumulated.has(dep.id)) {
      accumulated.add(dep.id);
      await _collectDependents(entitySkills, dep.id, accumulated);
    }
  }
}

function _entitySkills(entity, attachedToObject) {
  if (attachedToObject) {
    entity.state = entity.state ?? {};
    entity.state.skills = entity.state.skills ?? {};
    return entity.state.skills;
  }
  entity.skills = entity.skills ?? {};
  return entity.skills;
}

function _setEntitySkills(entity, attachedToObject, skills) {
  if (attachedToObject) {
    entity.state = entity.state ?? {};
    entity.state.skills = skills;
  } else {
    entity.skills = skills;
  }
}
