require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';

module.exports = {
  env,
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  dbFile: process.env.DB_FILE || './data/app.db',
  // Low cost factor in tests keeps the suite fast; 10+ in real use.
  bcryptRounds: env === 'test' ? 4 : 10,
};
