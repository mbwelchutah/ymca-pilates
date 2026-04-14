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

  // Structured failure log — one row per booking failure event.
  db.exec(`
    CREATE TABLE IF NOT EXISTS failures (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       INTEGER,
      occurred_at  TEXT NOT NULL,
      phase        TEXT NOT NULL,
      reason       TEXT NOT NULL,
      message      TEXT,
      class_title  TEXT,
      screenshot   TEXT
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
    // Structured failure enrichment columns (added in Stage 3.5+)
    'ALTER TABLE failures ADD COLUMN category TEXT NULL',
    'ALTER TABLE failures ADD COLUMN label TEXT NULL',
    'ALTER TABLE failures ADD COLUMN expected TEXT NULL',
    'ALTER TABLE failures ADD COLUMN actual TEXT NULL',
    'ALTER TABLE failures ADD COLUMN url TEXT NULL',
    'ALTER TABLE failures ADD COLUMN context_json TEXT NULL',
  ];
  for (const sql of addColumns) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }

  // Seed jobs from data/seed-jobs.json if the table is empty.
  // This ensures a fresh production deployment starts with the correct class list.
  const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  if (jobCount === 0) {
    const seedPath = path.join(DATA_DIR, 'seed-jobs.json');
    if (fs.existsSync(seedPath)) {
      try {
        const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        const insert = db.prepare(`
          INSERT INTO jobs
            (class_title, instructor, day_of_week, class_time, target_date, is_active,
             last_result, last_success_at, last_run_at, last_error_message, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const now = new Date().toISOString();
        const seedAll = db.transaction((rows) => {
          for (const r of rows) {
            insert.run(
              r.class_title,
              r.instructor         ?? null,
              r.day_of_week        ?? null,
              r.class_time         ?? null,
              r.target_date        ?? null,
              r.is_active !== undefined ? (r.is_active ? 1 : 0) : 1,
              r.last_result        ?? null,
              r.last_success_at    ?? null,
              r.last_run_at        ?? null,
              r.last_error_message ?? null,
              now
            );
          }
        });
        seedAll(seeds);
        console.log(`[db] Seeded ${seeds.length} job(s) from seed-jobs.json`);
      } catch (err) {
        console.error('[db] Failed to seed from seed-jobs.json:', err.message);
      }
    }
  }

  return db;
}

module.exports = { openDb };
