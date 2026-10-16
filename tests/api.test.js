const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createDb } = require('../src/db');
const { createApp } = require('../src/app');

let api;
const users = {};

async function register(name) {
  const res = await api.post('/api/auth/register').send({ name, email: `${name}@test.com`, password: 'password123' });
  assert.equal(res.status, 201);
  users[name] = { ...res.body.user, token: res.body.token };
}
const as = (name) => ({ Authorization: `Bearer ${users[name].token}` });

before(async () => {
  api = request(createApp(createDb(':memory:')));
  await register('alice');
  await register('bob');
  await register('carol');
});

test('auth: duplicate email, bad login, /me', async () => {
  const dup = await api.post('/api/auth/register').send({ name: 'x', email: 'alice@test.com', password: 'password123' });
  assert.equal(dup.status, 409);
  const bad = await api.post('/api/auth/login').send({ email: 'alice@test.com', password: 'wrongpass' });
  assert.equal(bad.status, 401);
  const me = await api.get('/api/auth/me').set(as('alice'));
  assert.equal(me.body.user.email, 'alice@test.com');
  assert.equal((await api.get('/api/auth/me')).status, 401);
});

test('validation errors return 400 with details', async () => {
  const res = await api.post('/api/auth/register').send({ name: '', email: 'nope', password: '1' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.length >= 3);
});

let projectId, issueId;

test('projects: create, membership, access control', async () => {
  const created = await api.post('/api/projects').set(as('alice')).send({ name: 'Backend', key: 'api' });
  assert.equal(created.status, 201);
  assert.equal(created.body.key, 'API'); // normalised
  projectId = created.body.id;

  // Duplicate key
  assert.equal((await api.post('/api/projects').set(as('bob')).send({ name: 'Other', key: 'API' })).status, 409);
  // Non-member cannot see it (404, not 403)
  assert.equal((await api.get(`/api/projects/${projectId}`).set(as('bob'))).status, 404);

  const add = await api.post(`/api/projects/${projectId}/members`).set(as('alice')).send({ email: 'bob@test.com' });
  assert.equal(add.status, 201);
  // Member (non-manager) cannot add members
  assert.equal((await api.post(`/api/projects/${projectId}/members`).set(as('bob')).send({ email: 'carol@test.com' })).status, 403);
  assert.equal((await api.get(`/api/projects/${projectId}`).set(as('bob'))).body.your_role, 'member');
});

test('issues: create assigns sequential keys, assignee must be member', async () => {
  const a = await api.post(`/api/projects/${projectId}/issues`).set(as('alice')).send({ title: 'First issue', type: 'bug', priority: 'high', assignee_id: users.bob.id });
  assert.equal(a.status, 201);
  assert.equal(a.body.issue_key, 'API-1');
  issueId = a.body.id;
  const b = await api.post(`/api/projects/${projectId}/issues`).set(as('bob')).send({ title: 'Second issue' });
  assert.equal(b.body.issue_key, 'API-2');

  const bad = await api.post(`/api/projects/${projectId}/issues`).set(as('alice')).send({ title: 'Bad assignee', assignee_id: users.carol.id });
  assert.equal(bad.status, 400);
});

test('issues: workflow transitions are enforced and logged', async () => {
  const skip = await api.patch(`/api/issues/${issueId}`).set(as('bob')).send({ status: 'done' });
  assert.equal(skip.status, 400); // todo -> done not allowed
  const ok = await api.patch(`/api/issues/${issueId}`).set(as('bob')).send({ status: 'in_progress' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'in_progress');

  const act = await api.get(`/api/issues/${issueId}/activity`).set(as('alice'));
  const actions = act.body.data.map((a) => a.action);
  assert.deepEqual(actions, ['created', 'status_changed']);
  assert.deepEqual(act.body.data[1].details, { from: 'todo', to: 'in_progress' });
});

test('issues: filtering, search, sorting, pagination', async () => {
  for (let i = 0; i < 5; i++) {
    await api.post(`/api/projects/${projectId}/issues`).set(as('alice')).send({ title: `Bulk item ${i}`, priority: i % 2 ? 'low' : 'critical' });
  }
  const page = await api.get(`/api/projects/${projectId}/issues?limit=3&page=2`).set(as('alice'));
  assert.equal(page.body.data.length, 3);
  assert.equal(page.body.meta.total, 7);
  assert.equal(page.body.meta.totalPages, 3);

  const bugs = await api.get(`/api/projects/${projectId}/issues?type=bug`).set(as('alice'));
  assert.equal(bugs.body.meta.total, 1);
  const mine = await api.get(`/api/projects/${projectId}/issues?assignee=me`).set(as('bob'));
  assert.equal(mine.body.meta.total, 1);
  const search = await api.get(`/api/projects/${projectId}/issues?q=bulk`).set(as('alice'));
  assert.equal(search.body.meta.total, 5);
  const sorted = await api.get(`/api/projects/${projectId}/issues?sort=priority&order=desc`).set(as('alice'));
  assert.equal(sorted.body.data[0].priority, 'critical');
  assert.equal((await api.get(`/api/projects/${projectId}/issues?limit=1000`).set(as('alice'))).status, 400);
});

test('comments: add, list, delete permissions', async () => {
  const c = await api.post(`/api/issues/${issueId}/comments`).set(as('bob')).send({ body: 'Working on it' });
  assert.equal(c.status, 201);
  const list = await api.get(`/api/issues/${issueId}/comments`).set(as('alice'));
  assert.equal(list.body.data[0].author, 'bob');
  assert.equal((await api.get(`/api/issues/${issueId}/comments`).set(as('carol'))).status, 404);
  // Alice is a manager -> can delete Bob's comment
  assert.equal((await api.delete(`/api/comments/${c.body.id}`).set(as('alice'))).status, 204);
});

test('stats endpoint aggregates correctly', async () => {
  const res = await api.get(`/api/projects/${projectId}/stats`).set(as('alice'));
  assert.equal(res.status, 200);
  assert.equal(res.body.by_status.in_progress, 1);
  assert.equal(res.body.by_status.todo, 6);
});

test('removing a member unassigns their issues; delete rules', async () => {
  assert.equal((await api.delete(`/api/projects/${projectId}/members/${users.bob.id}`).set(as('alice'))).status, 204);
  assert.equal((await api.get(`/api/issues/${issueId}`).set(as('alice'))).body.assignee_id, null);
  assert.equal((await api.delete(`/api/projects/${projectId}/members/${users.alice.id}`).set(as('alice'))).status, 400); // owner
  assert.equal((await api.delete(`/api/issues/${issueId}`).set(as('alice'))).status, 204);
  assert.equal((await api.get(`/api/issues/${issueId}`).set(as('alice'))).status, 404);
});

test('unknown routes and bad JSON are handled', async () => {
  assert.equal((await api.get('/api/nope')).status, 404);
  const res = await api.post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
  assert.equal(res.status, 400);
});
