const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/auth');
const { requireRole, getProjectRole, isMember } = require('../services/access');
const { canTransition, ISSUE_SELECT, getIssue, logActivity } = require('../services/issues');
const { notFound, badRequest, forbidden } = require('../utils/errors');

const id = z.coerce.number().int().positive();
const projectParams = z.object({ projectId: id });
const issueParams = z.object({ id });

const status = z.enum(['todo', 'in_progress', 'in_review', 'done']);
const priority = z.enum(['low', 'medium', 'high', 'critical']);
const type = z.enum(['task', 'bug', 'story']);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(5000).default(''),
  type: type.default('task'),
  priority: priority.default('medium'),
  assignee_id: z.number().int().positive().nullable().optional(),
  due_date: dueDate.nullable().optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().max(5000),
    type,
    priority,
    status,
    assignee_id: z.number().int().positive().nullable(),
    due_date: dueDate.nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field');

const listQuery = z.object({
  status: status.optional(),
  priority: priority.optional(),
  type: type.optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int().positive()]).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['created_at', 'updated_at', 'priority', 'due_date', 'number']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Sort priority by meaning (critical first), not alphabetically.
const SORT_SQL = {
  created_at: 'i.created_at',
  updated_at: 'i.updated_at',
  due_date: 'i.due_date',
  number: 'i.number',
  priority: "CASE i.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
};

module.exports = (db) => {
  const router = express.Router();
  // Scope auth to the paths this router owns, so unknown /api routes still reach the 404 handler.
  router.use(['/projects/:projectId/issues', '/me', '/issues'], authenticate(db));

  // Create an issue. The per-project number is assigned inside a transaction.
  router.post('/projects/:projectId/issues', validate(projectParams, 'params'), validate(createSchema), (req, res) => {
    const { projectId } = req.valid.params;
    requireRole(db, req.user, projectId);
    const b = req.valid.body;
    if (b.assignee_id && !isMember(db, projectId, b.assignee_id)) {
      throw badRequest('Assignee must be a member of the project');
    }

    const create = db.transaction(() => {
      const { next } = db
        .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM issues WHERE project_id = ?')
        .get(projectId);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO issues (project_id, number, title, description, type, priority, reporter_id, assignee_id, due_date)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(projectId, next, b.title, b.description, b.type, b.priority, req.user.id, b.assignee_id ?? null, b.due_date ?? null);
      logActivity(db, lastInsertRowid, req.user.id, 'created', { title: b.title });
      return lastInsertRowid;
    });
    res.status(201).json(getIssue(db, create()));
  });

  // List with filtering, search, sorting and pagination.
  router.get('/projects/:projectId/issues', validate(projectParams, 'params'), validate(listQuery, 'query'), (req, res) => {
    const { projectId } = req.valid.params;
    requireRole(db, req.user, projectId);
    const q = req.valid.query;

    const where = ['i.project_id = ?'];
    const params = [projectId];
    for (const col of ['status', 'priority', 'type']) {
      if (q[col]) { where.push(`i.${col} = ?`); params.push(q[col]); }
    }
    if (q.assignee === 'me') { where.push('i.assignee_id = ?'); params.push(req.user.id); }
    else if (q.assignee === 'none') where.push('i.assignee_id IS NULL');
    else if (q.assignee) { where.push('i.assignee_id = ?'); params.push(q.assignee); }
    if (q.q) {
      where.push('(i.title LIKE ? OR i.description LIKE ?)');
      params.push(`%${q.q}%`, `%${q.q}%`);
    }

    const whereSql = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM issues i WHERE ${whereSql}`).get(...params).n;
    // Column/direction come from a whitelist (zod enum) -> safe to interpolate.
    const rows = db
      .prepare(
        `${ISSUE_SELECT} WHERE ${whereSql}
         ORDER BY ${SORT_SQL[q.sort]} ${q.order === 'asc' ? 'ASC' : 'DESC'}, i.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, q.limit, (q.page - 1) * q.limit);

    res.json({ data: rows, meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } });
  });

  // Everything assigned to me across projects.
  router.get('/me/issues', (req, res) => {
    const rows = db
      .prepare(`${ISSUE_SELECT} WHERE i.assignee_id = ? AND i.status != 'done' ORDER BY i.due_date IS NULL, i.due_date, i.id DESC`)
      .all(req.user.id);
    res.json({ data: rows });
  });

  // Load issue + verify access in one step.
  const load = (req, roles) => {
    const issue = getIssue(db, req.valid.params.id);
    if (!issue) throw notFound('Issue not found');
    const role = requireRole(db, req.user, issue.project_id, roles);
    return { issue, role };
  };

  router.get('/issues/:id', validate(issueParams, 'params'), (req, res) => {
    res.json(load(req).issue);
  });

  router.get('/issues/:id/activity', validate(issueParams, 'params'), (req, res) => {
    const { issue } = load(req);
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.details, a.created_at, u.name AS user_name FROM activity a
         JOIN users u ON u.id = a.user_id WHERE a.issue_id = ? ORDER BY a.id`
      )
      .all(issue.id)
      .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
    res.json({ data: rows });
  });

  router.patch('/issues/:id', validate(issueParams, 'params'), validate(updateSchema), (req, res) => {
    const { issue } = load(req);
    const changes = req.valid.body;
    console.log('1. handler reached', req.user,this.name, req.valid.body)
    if (changes.status && !canTransition(issue.status, changes.status)) {
      throw badRequest(`Cannot move an issue from "${issue.status}" to "${changes.status}"`);
    }
    if (changes.assignee_id && !isMember(db, issue.project_id, changes.assignee_id)) {
      throw badRequest('Assignee must be a member of the project');
    }

    const update = db.transaction(() => {
      const keys = Object.keys(changes);
      const sets = keys.map((k) => `${k} = @${k}`).concat("updated_at = datetime('now')").join(', ');
      db.prepare(`UPDATE issues SET ${sets} WHERE id = @id`).run({ ...changes, id: issue.id });

      // Audit trail: record only fields that actually changed.
      for (const k of keys) {
        if (changes[k] === issue[k]) continue;
        const action = k === 'status' ? 'status_changed' : k === 'assignee_id' ? 'assigned' : `${k}_changed`;
        logActivity(db, issue.id, req.user.id, action, { from: issue[k], to: changes[k] });
      }
    });
    update();
    res.json(getIssue(db, issue.id));
  });

  // Delete: project managers or the original reporter only.
  router.delete('/issues/:id', validate(issueParams, 'params'), (req, res) => {
    const { issue, role } = load(req);
    if (role !== 'manager' && issue.reporter_id !== req.user.id) {
      throw forbidden('Only managers or the reporter can delete this issue');
    }
    db.prepare('DELETE FROM issues WHERE id = ?').run(issue.id);
    res.status(204).end();
  });

  return router;
};
