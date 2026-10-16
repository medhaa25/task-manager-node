const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../services/access');
const { getIssue, logActivity } = require('../services/issues');
const { notFound, forbidden } = require('../utils/errors');

const idParams = z.object({ id: z.coerce.number().int().positive() });
const bodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

module.exports = (db) => {
  const router = express.Router();
  router.use(['/issues', '/comments'], authenticate(db));

  const issueFor = (req) => {
    const issue = getIssue(db, req.valid.params.id);
    if (!issue) throw notFound('Issue not found');
    return issue;
  };

  router.get('/issues/:id/comments', validate(idParams, 'params'), (req, res) => {
    const issue = issueFor(req);
    requireRole(db, req.user, issue.project_id);
    const rows = db
      .prepare(
        `SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c
         JOIN users u ON u.id = c.user_id WHERE c.issue_id = ? ORDER BY c.id`
      )
      .all(issue.id);
    res.json({ data: rows });
  });

  router.post('/issues/:id/comments', validate(idParams, 'params'), validate(bodySchema), (req, res) => {
    const issue = issueFor(req);
    requireRole(db, req.user, issue.project_id);
    const add = db.transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO comments (issue_id, user_id, body) VALUES (?,?,?)')
        .run(issue.id, req.user.id, req.valid.body.body);
      logActivity(db, issue.id, req.user.id, 'commented', { comment_id: lastInsertRowid });
      return lastInsertRowid;
    });
    const id = add();
    res.status(201).json(db.prepare('SELECT id, body, created_at, user_id FROM comments WHERE id = ?').get(id));
  });

  router.delete('/comments/:id', validate(idParams, 'params'), (req, res) => {
    const c = db.prepare('SELECT c.*, i.project_id FROM comments c JOIN issues i ON i.id = c.issue_id WHERE c.id = ?').get(req.valid.params.id);
    if (!c) throw notFound('Comment not found');
    const role = requireRole(db, req.user, c.project_id);
    if (c.user_id !== req.user.id && role !== 'manager') throw forbidden('You can only delete your own comments');
    db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
    res.status(204).end();
  });

  return router;
};
