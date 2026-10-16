const { ZodError } = require('zod');
const { AppError } = require('../utils/errors');
const config = require('../config');

// Express recognises error handlers by their 4-argument signature.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(err.message)) {
    return res.status(409).json({ error: 'Database constraint violated' });
  }
  if (config.env !== 'test') console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
