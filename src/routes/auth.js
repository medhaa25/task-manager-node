const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../config');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/auth');
const { unauthorized, conflict } = require('../utils/errors');

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(100),
});
const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1),
});

const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

module.exports = (db) => {
  const router = express.Router();
  const auth = authenticate(db);

  router.post('/register', validate(registerSchema), async (req, res) => {
    const { name, email, password } = req.valid.body;
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw conflict('Email already registered');
    }
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    // Role is never taken from the client: everyone registers as 'user'.
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(name, email, hash);
    const user = { id: info.lastInsertRowid, name, email, role: 'user' };
    res.status(201).json({ user, token: signToken(user) });
  });

  router.post('/login', validate(loginSchema), async (req, res) => {
    const { email, password } = req.valid.body;
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same message for "no such user" and "wrong password" -> no user enumeration.
    const ok = row && (await bcrypt.compare(password, row.password_hash));
    if (!ok) throw unauthorized('Invalid email or password');
    const user = { id: row.id, name: row.name, email: row.email, role: row.role };
    res.json({ user, token: signToken(user) });
  });

  router.get('/me', auth, (req, res) => res.json({ user: req.user }));

  return router;
};
