'use strict';
const { nowIso } = require('./util');

// actor = { id, role, name } or null for system actions
function audit(db, actor, action, entityType, entityId, details) {
  db.prepare(
    'INSERT INTO audit_log (actor_user_id, actor_role, actor_name, action, entity_type, entity_id, details, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    actor ? actor.id : null,
    actor ? actor.role : 'system',
    actor ? actor.name : 'system',
    action,
    entityType,
    entityId === undefined || entityId === null ? null : String(entityId),
    details ? JSON.stringify(details) : null,
    nowIso()
  );
}

module.exports = { audit };
