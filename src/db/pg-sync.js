// PostgreSQL persistence layer for job data.
//
// Replit deployment containers start fresh from git on every publish, so
// SQLite (which is gitignored) resets each time.  This module bridges that
// gap by keeping a copy of the jobs table in Replit's persistent PostgreSQL
// database and restoring from it on every fresh start.
//
// Callers that use SQLite (jobs.js, init.js, etc.) are unchanged — they keep
// using the synchronous better-sqlite3 API.  PG operations here are all
// async and are either awaited at startup (initFromPg) or awaited explicitly
// by mutation handlers via syncJobsToPgAsync.

const fs   = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '../../data/seed-jobs.json');

// Lazily create a connection pool so this file can be required anywhere
// without immediately failing if PG env vars aren't set.
let _pool = null;
function getPool() {
  if (!_pool) {
    const { Pool } = require('pg');
    // Replit's cloud PostgreSQL requires SSL; the dev/local PG does not.
    // Cloud PG hostnames are FQDNs (contain dots); bare hostnames like
    // "helium" or "localhost" are dev/local.  rejectUnauthorized:false is
    // correct for cloud-managed DBs where the server cert isn't in the
    // system trust store.
    let _sslOpt = false;
    try {
      const _h = new URL(process.env.DATABASE_URL || '').hostname;
      if (_h.includes('.')) _sslOpt = { rejectUnauthorized: false };
    } catch (_) { /* DATABASE_URL not set or unparseable — no SSL */ }
    _pool = new Pool({ ssl: _sslOpt });
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
// from git is used and then pushed to PG via the startup syncJobsToPgAsync call.
async function initFromPg() {
  try {
    await ensurePgSchema();
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT class_title, instructor, day_of_week, class_time, target_date, is_active,
              last_result, last_success_at, last_run_at, last_error_message
       FROM jobs ORDER BY id`
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

// ── syncJobsToPgAsync ────────────────────────────────────────────────────────
// The only public PG sync API.  Called after every job mutation (create /
// delete / toggle / update / reset / cancel) and by CLI scripts.
// Replaces the entire PG jobs table with the current SQLite state.
// Uses a transaction so PG is never left in a partial state.
//
// Concurrent-safe via _syncChain serialisation: if two mutations fire at the
// same time, the second sync waits for the first to complete and then reads a
// fresh SQLite snapshot that captures both mutations.  This prevents the
// interleaved-DELETE bug where two concurrent BEGIN/DELETE/INSERT/COMMIT cycles
// each omit the other's rows and both COMMITs, resulting in duplicate rows.
//
// Always await this function — it returns a promise that resolves when PG is
// durable, or rejects if the sync failed.  Never call it fire-and-forget.

let _syncChain = Promise.resolve();

// Serialised public entry point.  Returns a promise that resolves/rejects with
// the outcome of THIS sync so callers can await it for durability.
function _doSyncJobsToPg() {
  const slot = _syncChain.then(() => _doSyncJobsToPgCore());
  // Advance the chain; swallow errors so a failed sync never blocks later ones.
  _syncChain = slot.catch(() => {});
  return slot;
}

// Core work — reads SQLite at execution time (not enqueue time) so it always
// captures the most-recent committed state of the jobs table.
async function _doSyncJobsToPgCore() {
  // Read the current job list from SQLite (authoritative runtime source).
  // Falls back to seed-jobs.json only if SQLite hasn't been initialised yet
  // (e.g. during a very early startup before openDb() is first called).
  let jobs;
  try {
    const { openDb } = require('./init');
    const db = openDb();
    jobs = db.prepare(`SELECT class_title, instructor, day_of_week, class_time, target_date, is_active,
                              last_result, last_success_at, last_run_at, last_error_message FROM jobs`).all();
  } catch (_) {
    if (!fs.existsSync(SEED_PATH)) return;
    jobs = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  }

  await ensurePgSchema();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM jobs');
    for (const j of jobs) {
      await client.query(
        `INSERT INTO jobs
           (class_title, instructor, day_of_week, class_time, target_date, is_active,
            last_result, last_success_at, last_run_at, last_error_message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          j.class_title,
          j.instructor        ?? null,
          j.day_of_week       ?? null,
          j.class_time        ?? null,
          j.target_date       ?? null,
          j.is_active !== undefined ? (j.is_active ? 1 : 0) : 1,
          j.last_result       ?? null,
          j.last_success_at   ?? null,
          j.last_run_at       ?? null,
          j.last_error_message ?? null,
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

module.exports = { initFromPg, syncJobsToPgAsync: _doSyncJobsToPg };
