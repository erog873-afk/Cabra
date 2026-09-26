const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'apexloot.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    telegram_user_id  INTEGER PRIMARY KEY,
    language          TEXT    NOT NULL DEFAULT 'ru',
    vibration_enabled INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const getStmt = db.prepare(
  'SELECT telegram_user_id, language, vibration_enabled FROM user_settings WHERE telegram_user_id = ?'
);

const upsertStmt = db.prepare(`
  INSERT INTO user_settings (telegram_user_id, language, vibration_enabled, updated_at)
  VALUES (@userId, @language, @vibration, datetime('now'))
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    language = excluded.language,
    vibration_enabled = excluded.vibration_enabled,
    updated_at = datetime('now')
`);

function getSettings(userId) {
  const row = getStmt.get(userId);
  if (!row) return null;
  return {
    userId: row.telegram_user_id,
    language: row.language,
    vibration: !!row.vibration_enabled
  };
}

function saveSettings(userId, language, vibration) {
  upsertStmt.run({
    userId,
    language,
    vibration: vibration ? 1 : 0
  });
  return getSettings(userId);
}

module.exports = { getSettings, saveSettings };
