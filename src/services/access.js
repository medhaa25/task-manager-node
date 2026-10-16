const { notFound, forbidden } = require('../utils/errors');

function getProjectRole(db, user, projectId) {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw notFound('Project not found');
  if (user.role === 'admin') return 'manager';

  const row = db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, user.id);
  if (!row) throw notFound('Project not found');
  return row.role;
}

function requireRole(db, user, projectId, allowed = ['member', 'manager']) {
  const role = getProjectRole(db, user, projectId);
  if (!allowed.includes(role)) throw forbidden('Manager role required');
  return role;
}

function isMember(db, projectId, userId) {
  return !!db
    .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId);
}

module.exports = { getProjectRole, requireRole, isMember };
