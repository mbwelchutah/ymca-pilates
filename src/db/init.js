// Opens (or creates) the SQLite database and ensures the schema exists.
// Call openDb() anywhere you need a database connection.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
// SQLITE_PATH lets isolated test runs point at a throwaway DB file so they
// can call destructive helpers (clearFailures, etc.) without nuking dev data.
// Production / dev always uses the canonical data/app.db.
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'app.db');

// Guard: sync-from-seed must run exactly once per process (at startup).
// Running it on every openDb() call would revert user edits made via the
// update-job API, because seed-jobs.json is only rewritten at startup from
// PostgreSQL — not when a job is edited in-process.
let _seedSynced = false;

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
    // Task #66 — track how many times a one-off has been advanced in succession
    // (reset on conversion/dismiss) and whether the user has dismissed the
    // "Make this weekly?" suggestion for this specific job.
    'ALTER TABLE jobs ADD COLUMN advance_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE jobs ADD COLUMN weekly_suggest_dismissed INTEGER NOT NULL DEFAULT 0',
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

  // Seed / sync jobs from data/seed-jobs.json — run exactly once per process.
  // This ensures a fresh deployment starts with the correct class list, and
  // applies timezone / config corrections to an existing DB on first boot.
  // Guard prevents this from re-running on every openDb() call (which would
  // overwrite in-process job edits made via the update-job API).
  const seedPath = path.join(DATA_DIR, 'seed-jobs.json');
  if (!_seedSynced && fs.existsSync(seedPath)) {
    _seedSynced = true;
    const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    try {
      const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      if (jobCount === 0) {
        const insert = db.prepare(`
          INSERT INTO jobs
            (class_title, instructor, day_of_week, class_time, target_date, is_active,
             last_result, last_success_at, last_run_at, last_error_message,
             advance_count, weekly_suggest_dismissed, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              Number.isFinite(r.advance_count) ? r.advance_count : 0,
              r.weekly_suggest_dismissed ? 1 : 0,
              now
            );
          }
        });
        seedAll(seeds);
        console.log(`[db] Seeded ${seeds.length} job(s) from seed-jobs.json`);
      } else {
        // Task #68 — root drift fix.
        // Previously the else branch only UPDATEd existing rows by class_title
        // and never INSERTed seed rows missing from SQLite.  That left an
        // SQLite-vs-(PG/seed) divergence whenever a new job appeared in PG
        // (and thus in seed-jobs.json after pg-init) without first being
        // created locally — exactly the "Yoga Nidra disappeared" pattern the
        // integrity-audit started flagging.  We now insert any seed row whose
        // identity tuple (class_title + day_of_week + class_time + target_date)
        // is absent from SQLite, BEFORE running the per-row config sync.
        const tupleKey = (r) =>
          [r.class_title ?? '', r.day_of_week ?? '', r.class_time ?? '', r.target_date ?? ''].join('|');
        const existingTuples = new Set(
          db.prepare('SELECT class_title, day_of_week, class_time, target_date FROM jobs').all().map(tupleKey)
        );
        const missing = seeds.filter(r => !existingTuples.has(tupleKey(r)));
        if (missing.length > 0) {
          const insert = db.prepare(`
            INSERT INTO jobs
              (class_title, instructor, day_of_week, class_time, target_date, is_active,
               last_result, last_success_at, last_run_at, last_error_message,
               advance_count, weekly_suggest_dismissed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const now = new Date().toISOString();
          const insertAll = db.transaction((rows) => {
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
                Number.isFinite(r.advance_count) ? r.advance_count : 0,
                r.weekly_suggest_dismissed ? 1 : 0,
                now
              );
            }
          });
          insertAll(missing);
          console.log(`[db] sync-from-seed: inserted ${missing.length} drift-recovered row(s) into SQLite (${missing.map(m => m.class_title).join(', ')})`);
        }
        // Sync config fields from seed-jobs.json into existing rows.
        // seed-jobs.json is always written by the UI on save, so it reflects the
        // latest intended configuration. This corrects stale fields in a persistent
        // production DB that pre-dates a config change (e.g. class_time timezone fix).
        const updateStmt = db.prepare(`
          UPDATE jobs
             SET class_time  = ?,
                 instructor  = ?,
                 day_of_week = ?,
                 target_date = ?
           WHERE class_title = ?
             AND (class_time != ? OR instructor != ? OR day_of_week != ? OR target_date != ?)
        `);
        const syncConfig = db.transaction((rows) => {
          let updated = 0;
          for (const r of rows) {
            const ct  = r.class_time  ?? null;
            const ins = r.instructor  ?? null;
            const dow = r.day_of_week ?? null;
            const td  = r.target_date ?? null;
            const res = updateStmt.run(ct, ins, dow, td, r.class_title, ct, ins, dow, td);
            if (res.changes > 0) {
              console.log(`[db] sync-from-seed updated job "${r.class_title}": class_time=${ct}, instructor=${ins}, day_of_week=${dow}, target_date=${td}`);
              updated++;
            }
          }
          return updated;
        });
        const updated = syncConfig(seeds);
        if (updated > 0) console.log(`[db] sync-from-seed: updated ${updated} job(s) from seed-jobs.json`);
      }
    } catch (err) {
      console.error('[db] Failed to seed/sync from seed-jobs.json:', err.message);
    }
  }

  return db;
}

module.exports = { openDb };
