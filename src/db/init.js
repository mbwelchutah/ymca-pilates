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

  return db;
}

module.exports = { openDb };
