

// Workflow state machine: which statuses may follow which.
const TRANSITIONS = {
  todo: ['in_progress'],
  in_progress: ['todo', 'in_review', 'done'],
  in_review: ['in_progress', 'done'],
  done: ['in_progress'], 
};

const canTransition = (from, to) => from === to || TRANSITIONS[from].includes(to);

const ISSUE_SELECT = `
  SELECT i.*, p.key || '-' || i.number AS issue_key,
         a.name AS assignee_name, r.name AS reporter_name
  FROM issues i
  JOIN projects p ON p.id = i.project_id
  JOIN users r ON r.id = i.reporter_id
  LEFT JOIN users a ON a.id = i.assignee_id`;

const getIssue = (db, id) => db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(id);

function logActivity(db, issueId, userId, action, details) {
  db.prepare('INSERT INTO activity (issue_id, user_id, action, details) VALUES (?,?,?,?)').run(
    issueId,
    userId,
    action,
    details ? JSON.stringify(details) : null
  );
}

module.exports = { TRANSITIONS, canTransition, ISSUE_SELECT, getIssue, logActivity };
