// Opens (or creates) the SQLite database and ensures the schema exists.
// Call openDb() anywhere you need a database connection.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      class_title  TEXT    NOT NULL,
      instructor   TEXT,
      day_of_week  TEXT,
      class_time   TEXT,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL
    )
  `);

  // Cache table for scraped YMCA schedule data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraped_classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      class_title TEXT    NOT NULL,
      day_of_week TEXT    NOT NULL,
      class_time  TEXT    NOT NULL,
      instructor  TEXT,
      scraped_at  TEXT    NOT NULL
    )
  `);

  // Safely add new columns to existing databases that predate them.
  // SQLite does not support "ADD COLUMN IF NOT EXISTS", so we try and ignore
  // the error that fires when the column is already there.
  const addColumns = [
    'ALTER TABLE jobs ADD COLUMN last_run_at TEXT NULL',
    'ALTER TABLE jobs ADD COLUMN last_result TEXT NULL',
    'ALTER TABLE jobs ADD COLUMN last_success_at TEXT NULL',
    'ALTER TABLE jobs ADD COLUMN target_date TEXT NULL',
    'ALTER TABLE jobs ADD COLUMN last_error_message TEXT NULL',
  ];
  for (const sql of addColumns) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }

  return db;
}

module.exports = { openDb };
