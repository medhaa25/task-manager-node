const bcrypt = require('bcryptjs');
const config = require('../config');
const { createDb } = require('./index');

const db = createDb(config.dbFile);
const hash = bcrypt.hashSync('password123', 10);

db.transaction(() => {
  const user = db.prepare('INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?,?,?,?)');
  user.run('Admin', 'admin@example.com', hash, 'admin');
  user.run('Asha Rao', 'asha@example.com', hash, 'user');
  user.run('Ben Carter', 'ben@example.com', hash, 'user');
  const id = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;

  if (db.prepare("SELECT 1 FROM projects WHERE key = 'WEB'").get()) return console.log('Already seeded.');

  const { lastInsertRowid: pid } = db.prepare("INSERT INTO projects (name, key, description, owner_id) VALUES ('Website Revamp','WEB','Marketing site rebuild',?)").run(id('asha@example.com'));
  const member = db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)');
  member.run(pid, id('asha@example.com'), 'manager');
  member.run(pid, id('ben@example.com'), 'member');

  const issue = db.prepare('INSERT INTO issues (project_id, number, title, description, type, status, priority, reporter_id, assignee_id, due_date) VALUES (?,?,?,?,?,?,?,?,?,?)');
  issue.run(pid, 1, 'Design new landing page', 'Hero, features, pricing', 'story', 'in_progress', 'high', id('asha@example.com'), id('ben@example.com'), '2026-11-01');
  issue.run(pid, 2, 'Fix broken contact form', 'Submit returns 500', 'bug', 'todo', 'critical', id('ben@example.com'), id('asha@example.com'), '2026-10-20');
  issue.run(pid, 3, 'Set up CI pipeline', '', 'task', 'done', 'medium', id('asha@example.com'), null, null);
  console.log('Seeded. Logins: admin@/asha@/ben@example.com, password: password123');
})();
