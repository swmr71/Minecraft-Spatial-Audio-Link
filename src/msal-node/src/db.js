const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const config = require('./config');

const dbPath = config.dbPath || path.join(__dirname, '..', 'db.sqlite3');
const db = new DatabaseSync(dbPath);

// 旧スキーマ（created_at が TEXT）の場合は作り直す。ログインコードは短命なので破棄して問題ない。
const legacy = db.prepare("SELECT type FROM pragma_table_info('login_tokens') WHERE name = 'created_at'").get();
if (legacy && legacy.type.toUpperCase() !== 'INTEGER') {
  db.exec('DROP TABLE login_tokens');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS login_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL,
    mc_name TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_tokens_uuid ON login_tokens(uuid);
  CREATE INDEX IF NOT EXISTS idx_login_tokens_mc_name ON login_tokens(mc_name);
`);

module.exports = db;
