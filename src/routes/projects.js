const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/auth');
const { getProjectRole, requireRole } = require('../services/access');
const { notFound, conflict, forbidden, badRequest } = require('../utils/errors');

const idParam = z.object({ id: z.coerce.number().int().positive() });
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  key: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Key must be 2-6 letters'),
  description: z.string().max(1000).default(''),
});
const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(1000),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Provide at least one field');
const addMemberSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.enum(['member', 'manager']).default('member'),
});

module.exports = (db) => {
  const router = express.Router();
  router.use(authenticate(db));

  // Create project; creator becomes owner + manager (atomic via transaction).
  router.post('/', validate(createSchema), (req, res) => {
    const { name, key, description } = req.valid.body;
    if (db.prepare('SELECT 1 FROM projects WHERE key = ?').get(key)) {
      throw conflict(`Project key "${key}" is already taken`);
    }
    const create = db.transaction(() => {
      const { lastInsertRowid: id } = db
        .prepare('INSERT INTO projects (name, key, description, owner_id) VALUES (?,?,?,?)')
        .run(name, key, description, req.user.id);
      db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,'manager')").run(
        id,
        req.user.id
      );
      return id;
    });
    const id = create();
    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  });

  // Projects the user belongs to (admins see all), with counts.
  router.get('/', (req, res) => {
    const base = `
      SELECT p.*,
        (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
        (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id AND i.status != 'done') AS open_issues
      FROM projects p`;
    const rows =
      req.user.role === 'admin'
        ? db.prepare(`${base} ORDER BY p.created_at DESC`).all()
        : db
            .prepare(
              `${base} JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
               ORDER BY p.created_at DESC`
            )
            .all(req.user.id);
    res.json({ data: rows });
  });

  router.get('/:id', validate(idParam, 'params'), (req, res) => {
    const { id } = req.valid.params;
    const role = getProjectRole(db, req.user, id);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    const members = db
      .prepare(
        `SELECT u.id, u.name, u.email, pm.role FROM project_members pm
         JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`
      )
      .all(id);
    res.json({ ...project, your_role: role, members });
  });

  router.patch('/:id', validate(idParam, 'params'), validate(updateSchema), (req, res) => {
    const { id } = req.valid.params;
    requireRole(db, req.user, id, ['manager']);
    const fields = req.valid.body;
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE projects SET ${sets} WHERE id = @id`).run({ ...fields, id });
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  });

  router.delete('/:id', validate(idParam, 'params'), (req, res) => {
    const { id } = req.valid.params;
    getProjectRole(db, req.user, id);
    const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(id);
    if (project.owner_id !== req.user.id && req.user.role !== 'admin') {
      throw forbidden('Only the project owner can delete it');
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id); // cascades to issues, comments...
    res.status(204).end();
  });

  // ---- members ----
  router.post('/:id/members', validate(idParam, 'params'), validate(addMemberSchema), (req, res) => {
    const { id } = req.valid.params;
    requireRole(db, req.user, id, ['manager']);
    const { email, role } = req.valid.body;
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) throw notFound('No registered user with that email');
    const exists = db
      .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(id, user.id);
    if (exists) throw conflict('User is already a member');
    db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)').run(id, user.id, role);
    res.status(201).json({ ...user, role });
  });

  router.delete('/:id/members/:userId', validate(memberParams, 'params'), (req, res) => {
    const { id, userId } = req.valid.params;
    requireRole(db, req.user, id, ['manager']);
    const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(id);
    if (project.owner_id === userId) throw badRequest('Cannot remove the project owner');
    const remove = db.transaction(() => {
      // Unassign their open work so nothing is orphaned on a departed member.
      db.prepare('UPDATE issues SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?').run(id, userId);
      return db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
    });
    if (remove().changes === 0) throw notFound('Member not found');
    res.status(204).end();
  });

  // ---- stats (aggregation queries) ----
  router.get('/:id/stats', validate(idParam, 'params'), (req, res) => {
    const { id } = req.valid.params;
    requireRole(db, req.user, id);
    const group = (col) =>
      Object.fromEntries(
        db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM issues WHERE project_id = ? GROUP BY ${col}`)
          .all(id).map((r) => [r.k, r.n])
      );
    const overdue = db
      .prepare(
        `SELECT COUNT(*) AS n FROM issues
         WHERE project_id = ? AND status != 'done' AND due_date IS NOT NULL AND due_date < date('now')`
      )
      .get(id).n;
    const workload = db
      .prepare(
        `SELECT u.id, u.name, COUNT(*) AS open_issues FROM issues i
         JOIN users u ON u.id = i.assignee_id
         WHERE i.project_id = ? AND i.status != 'done'
         GROUP BY u.id ORDER BY open_issues DESC`
      )
      .all(id);
    res.json({ by_status: group('status'), by_priority: group('priority'), by_type: group('type'), overdue, workload });
  });

  return router;
};
