const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const errorHandler = require('./middleware/error');

/** App factory: takes a db so tests can inject an in-memory database. */
function createApp(db) {
  const app = express();

  // Relax CSP just enough for the tiny inline-script demo page.
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'", "'unsafe-inline'"], 'script-src-attr': ["'unsafe-inline'"] } } }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  if (config.env !== 'test') app.use(morgan('dev'));

  // Brute-force protection on login/register only.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false, skip: () => config.env === 'test' });
  app.use('/api/auth', authLimiter, require('./routes/auth')(db));

  app.use('/api/projects', require('./routes/projects')(db));
  app.use('/api', require('./routes/issues')(db));
  app.use('/api', require('./routes/comments')(db));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
