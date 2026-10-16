# Team Task & Issue Management System

A Jira-lite REST API built with **Node.js, Express 5 and SQLite** (raw SQL via `node:sqlite`).
The frontend is a single static page; the point of this project is the backend.


## Quick start

```bash
npm install
cp .env.example .env     
npm run seed             # optional demo data (password for all users: password123)
npm run dev              
npm test                 
```

Seeded logins: `admin@example.com` (global admin), `asha@example.com` (manager), `ben@example.com` (member).

## Project layout

```
src/
  app.js            app factory (takes a db -> easy to test)
  server.js         boot + graceful shutdown
  config.js         env config
  db/               schema.sql, connection, seed script
  middleware/       auth (JWT), validate (zod), error (central handler)
  routes/           auth, projects, issues, comments
  services/         access.js (RBAC), issues.js (workflow + activity log)
tests/api.test.js   end-to-end tests with supertest
public/index.html   minimal demo UI
```

## Data model

`users` -> `project_members` (role: member | manager) <- `projects` -> `issues` -> `comments`, `activity`

## API

All routes except `/api/auth/register|login` and `/api/health` need `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` `/login` | returns `{user, token}` |
| GET | `/api/auth/me` | current user |
| POST/GET | `/api/projects` | create (key like `WEB`) / list mine |
| GET/PATCH/DELETE | `/api/projects/:id` | PATCH = manager, DELETE = owner/admin |
| POST | `/api/projects/:id/members` | `{email, role}` manager only |
| DELETE | `/api/projects/:id/members/:userId` | unassigns their issues |
| GET | `/api/projects/:id/stats` | counts by status/priority/type, overdue, workload |
| POST/GET | `/api/projects/:id/issues` | list supports filters, see below |
| GET/PATCH/DELETE | `/api/issues/:id` | status transitions validated |
| GET | `/api/issues/:id/activity` | audit trail |
| GET/POST | `/api/issues/:id/comments` | |
| DELETE | `/api/comments/:id` | author or manager |
| GET | `/api/me/issues` | my open issues across projects |

**List query params:** `status`, `priority`, `type`, `assignee` (`me` | `none` | id), `q` (search),
`sort` (`created_at|updated_at|priority|due_date|number`), `order`, `page`, `limit` (max 100).

**Workflow:** `todo -> in_progress -> in_review -> done` (can step back; `done` can only reopen to `in_progress`).

Example:
```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"asha@example.com","password":"password123"}' | jq -r .token)
curl -s -X POST localhost:3000/api/projects/1/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"Add dark mode","priority":"high"}'
```

## Backend concepts to study in the code

1. **Layering & app factory** - `createApp(db)` lets tests inject an in-memory DB.
2. **Auth** - bcrypt hashing, JWT, no user enumeration on login, role never accepted from client input.
3. **Authorization (RBAC)** - global role + per-project role in `services/access.js`; non-members get 404 not 403.
4. **Validation** - zod schemas per route, coercion of query strings, centralized error format.
5. **SQL** - parameterised queries (no injection), whitelisted `ORDER BY`, aggregation, indexes, FK + CHECK constraints.
6. **Transactions** - per-project issue numbering, project creation, activity logging stay atomic.
7. **State machine** - transition rules in `services/issues.js`.
8. **Pagination/filtering/search** with a total count.
9. **Security basics** - helmet, CORS, rate limiting on auth, JSON body size cap.
10. **Testing** - black-box API tests with `node:test` + supertest.

## Ideas to extend

- Refresh tokens / logout (token blacklist)
- Labels, sprints, file attachments (multer)
- Swap SQLite for PostgreSQL (`pg`) and add a migration tool
- WebSocket notifications, email on assignment
- Redis caching for `/stats`; Docker + CI
