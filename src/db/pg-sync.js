// PostgreSQL persistence layer for job data.
//
// Replit deployment containers start fresh from git on every publish, so
// SQLite (which is gitignored) resets each time.  This module bridges that
// gap by keeping a copy of the jobs table in Replit's persistent PostgreSQL
// database and restoring from it on every fresh start.
//
// Callers that use SQLite (jobs.js, init.js, etc.) are unchanged — they keep
// using the synchronous better-sqlite3 API.  PG operations here are all
// async and are either awaited at startup (initFromPg) or fire-and-forget
// after mutations (syncJobsToPg).

const fs   = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '../../data/seed-jobs.json');

// Lazily create a connection pool so this file can be required anywhere
// without immediately failing if PG env vars aren't set.
let _pool = null;
function getPool() {
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool();
    _pool.on('error', (err) => {
      console.error('[pg-sync] Idle client error (non-fatal):', err.message);
    });
  }
  return _pool;
}

// Ensure the jobs table exists in PostgreSQL.
async function ensurePgSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                 SERIAL PRIMARY KEY,
      class_title        TEXT    NOT NULL,
      instructor         TEXT,
      day_of_week        TEXT,
      class_time         TEXT,
      is_active          INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT    NOT NULL,
      last_run_at        TEXT,
      last_result        TEXT,
      last_success_at    TEXT,
      target_date        TEXT,
      last_error_message TEXT
    )
  `);
}

// ── initFromPg ────────────────────────────────────────────────────────────────
// Called ONCE at server startup, BEFORE openDb() is first invoked.
// If PostgreSQL has jobs, writes them to seed-jobs.json so that init.js
// seeds the fresh SQLite DB from PG data instead of the stale git snapshot.
// If PG is empty (very first ever deployment), the existing seed-jobs.json
// from git is used and then pushed to PG via syncJobsToPg().
async function initFromPg() {
  try {
    await ensurePgSchema();
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT class_title, instructor, day_of_week, class_time, target_date, is_active FROM jobs ORDER BY id'
    );
    if (rows.length > 0) {
      fs.writeFileSync(SEED_PATH, JSON.stringify(rows, null, 2), 'utf8');
      console.log(`[pg-sync] Restored ${rows.length} job(s) from PostgreSQL → seed-jobs.json`);
    } else {
      console.log('[pg-sync] PostgreSQL jobs table is empty — will seed from git snapshot, then push to PG.');
    }
  } catch (err) {
    console.error('[pg-sync] initFromPg failed (non-fatal, will use seed-jobs.json):', err.message);
  }
}

// ── syncJobsToPg ─────────────────────────────────────────────────────────────
// Called fire-and-forget after every job mutation (create / delete / toggle /
// update).  Replaces the entire PG jobs table with the current SQLite state.
// Uses a transaction so PG is never left in a partial state.
function syncJobsToPg() {
  _doSyncJobsToPg().catch(err =>
    console.error('[pg-sync] syncJobsToPg failed (non-fatal):', err.message)
  );
}

async function _doSyncJobsToPg() {
  // Read from SQLite via the seed-jobs.json that syncSeed() just wrote.
  // (This file is always up-to-date because jobs.js writes it on every mutation.)
  if (!fs.existsSync(SEED_PATH)) return;
  const jobs = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

  await ensurePgSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM jobs');
    for (const j of jobs) {
      await client.query(
        `INSERT INTO jobs (class_title, instructor, day_of_week, class_time, target_date, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          j.class_title,
          j.instructor   ?? null,
          j.day_of_week  ?? null,
          j.class_time   ?? null,
          j.target_date  ?? null,
          j.is_active !== undefined ? (j.is_active ? 1 : 0) : 1,
          new Date().toISOString(),
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`[pg-sync] Synced ${jobs.length} job(s) to PostgreSQL.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initFromPg, syncJobsToPg };
