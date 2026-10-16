const config = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');

const db = createDb(config.dbFile);
const server = createApp(db).listen(config.port, () => {
  console.log(`Task manager running on http://localhost:${config.port}`);
});

// Graceful shutdown: stop accepting requests, then close the DB.
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => { db.close(); process.exit(0); });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
