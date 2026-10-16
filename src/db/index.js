const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ (no native compile step)

/** Tiny extension: node:sqlite has no transaction helper, so we add one. */
class Db extends DatabaseSync {
  /** db.transaction(fn) returns a function that runs fn atomically (commit, or rollback on throw). */
  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN');
      try {
        const result = fn(...args);
        this.exec('COMMIT');
        return result;
      } catch (err) {
        this.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

/** Open (and migrate) a SQLite database. Pass ':memory:' for tests. */
function createDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Db(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON'); // SQLite does NOT enforce FKs unless you ask
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

module.exports = { createDb };
