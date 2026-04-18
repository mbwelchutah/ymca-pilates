// PostgreSQL persistence layer for the structured failure log.
//
// Replit deployment containers start fresh from git on every publish, so the
// SQLite `failures` table (which is gitignored) is wiped each time.  The
// Failure Insights panel and trend windows treat that history as durable, so
// before this module landed users would see their failure log silently vanish
// after a redeploy.
//
// This module mirrors every failure row to a sibling PostgreSQL table and
// restores them back into a fresh SQLite at startup, the same way `pg-sync.js`
// does for the jobs table.  Mirror writes are awaitable but always called
// fire-and-forget by the synchronous failure-recording path so a transient PG
// outage cannot block booking/operational code.

const fs   = require('fs');
const path = require('path');

// Reuses the same pg-init success marker as pg-sync.js — failures restore is
// only meaningful when pg-init also succeeded (otherwise PG was unreachable
// and the local SQLite is whatever git seeded).  Mirror inserts do NOT need
// the marker (single-row INSERTs cannot wipe data the way DELETE+INSERT can).
const INIT_MARKER = path.join(__dirname, '../../data/.pg-init-status.json');

// Records the outcome of the most recent restoreFailuresFromPg() call.  pg-init
// runs in a separate, short-lived process from the long-running server, so we
// cannot share state via a module variable — the file is the only durable
// channel between the two.  GET /api/failures reads it via getRestoreStatus()
// to surface "Restored N rows at ..." (or the error reason) on the Failure
// Insights panel, so an operator can confirm at a glance that the durable
// PG restore actually ran on the latest boot.
const RESTORE_STATUS_FILE = path.join(__dirname, '../../data/.pg-failures-restore-status.json');

function writeRestoreStatus(status) {
  try {
    fs.mkdirSync(path.dirname(RESTORE_STATUS_FILE), { recursive: true });
    fs.writeFileSync(RESTORE_STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
  } catch (e) {
    console.error('[pg-failures] failed to write restore-status marker (non-fatal):', e.message);
  }
}

// Synchronously read the most recent restore outcome.  Returns null if the
// marker file is missing (e.g. PG not configured, or this is the first boot
// after the feature landed and pg-init hasn't run yet).  Returned object
// shape mirrors what writeRestoreStatus stamps below.
function getRestoreStatus() {
  try {
    return JSON.parse(fs.readFileSync(RESTORE_STATUS_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

let _pool = null;
function getPool() {
  if (!_pool) {
    const { Pool } = require('pg');
    let _sslOpt = false;
    try {
      const _h = new URL(process.env.DATABASE_URL || '').hostname;
      if (_h.includes('.')) _sslOpt = { rejectUnauthorized: false };
    } catch (_) { /* DATABASE_URL not set or unparseable — no SSL */ }
    _pool = new Pool({ ssl: _sslOpt });
    _pool.on('error', (err) => {
      console.error('[pg-failures] Idle client error (non-fatal):', err.message);
    });
  }
  return _pool;
}

let _schemaReady = null;
async function ensurePgFailuresSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failures (
        id           BIGSERIAL PRIMARY KEY,
        job_id       INTEGER,
        occurred_at  TEXT NOT NULL,
        phase        TEXT NOT NULL,
        reason       TEXT NOT NULL,
        message      TEXT,
        class_title  TEXT,
        screenshot   TEXT,
        category     TEXT,
        label        TEXT,
        expected     TEXT,
        actual       TEXT,
        url          TEXT,
        context_json TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failures_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS failures_occurred_at_idx ON failures(occurred_at DESC)`
    );
  })().catch((err) => {
    _schemaReady = null; // allow retry on next call
    throw err;
  });
  return _schemaReady;
}

// Mirror a single freshly-recorded failure row to PostgreSQL.  Resolves when
// the row is durable in PG; rejects only on programmer error — connectivity
// failures are caught and logged so this never blocks the caller.
//
// Callers should still treat the returned promise as fire-and-forget UNLESS
// they specifically want to await durability (tests, scripts).
async function mirrorFailureToPg(row) {
  if (!process.env.DATABASE_URL) return; // PG not configured (e.g. test envs)
  try {
    await ensurePgFailuresSchema();
    const pool = getPool();
    await pool.query(
      `INSERT INTO failures
         (job_id, occurred_at, phase, reason, message, class_title, screenshot,
          category, label, expected, actual, url, context_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.job_id      ?? null,
        row.occurred_at,
        row.phase,
        row.reason,
        row.message     ?? null,
        row.class_title ?? null,
        row.screenshot  ?? null,
        row.category    ?? null,
        row.label       ?? null,
        row.expected    ?? null,
        row.actual      ?? null,
        row.url         ?? null,
        row.context_json ?? null,
      ]
    );
  } catch (err) {
    console.error('[pg-failures] mirror insert failed (non-fatal):', err.message);
  }
}

// Pull the durable PG failure history into a freshly-bootstrapped SQLite.
// Idempotent: rows already present in SQLite (matched by occurred_at + phase
// + reason + job_id) are skipped, so re-running this within the same process
// does not double-count.
//
// Also restores `failures_meta.resetAt` from PG, overriding the fresh
// timestamp init.js stamps on first openDb() — so the Failure Insights "since
// X" label reflects the real durable reset point, not the latest container
// boot.
async function restoreFailuresFromPg() {
  if (!process.env.DATABASE_URL) return;
  const startedAt = new Date().toISOString();
  if (!fs.existsSync(INIT_MARKER)) {
    // pg-init didn't succeed this boot — PG may be unreachable.  We still try
    // to read failures (read-only is safe), but log the gap for the operator.
    console.warn('[pg-failures] pg-init marker missing — attempting failure restore anyway (read-only).');
  }
  try {
    await ensurePgFailuresSchema();
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT job_id, occurred_at, phase, reason, message, class_title, screenshot,
              category, label, expected, actual, url, context_json
       FROM failures ORDER BY id`
    );
    const { rows: metaRows } = await pool.query(
      `SELECT key, value FROM failures_meta`
    );

    const { openDb } = require('./init');
    const db = openDb();

    const existing = new Set(
      db.prepare(
        'SELECT occurred_at, phase, reason, COALESCE(job_id, -1) AS j FROM failures'
      ).all().map(r => `${r.occurred_at}|${r.phase}|${r.reason}|${r.j}`)
    );

    const insert = db.prepare(`
      INSERT INTO failures
        (job_id, occurred_at, phase, reason, message, class_title, screenshot,
         category, label, expected, actual, url, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        const key = `${r.occurred_at}|${r.phase}|${r.reason}|${r.job_id ?? -1}`;
        if (existing.has(key)) continue;
        insert.run(
          r.job_id, r.occurred_at, r.phase, r.reason, r.message,
          r.class_title, r.screenshot, r.category, r.label,
          r.expected, r.actual, r.url, r.context_json
        );
        inserted++;
      }
    });
    tx(rows);

    const upsertMeta = db.prepare(
      `INSERT INTO failures_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    let restoredResetAt = false;
    for (const m of metaRows) {
      upsertMeta.run(m.key, m.value);
      if (m.key === 'resetAt') restoredResetAt = true;
    }

    // First boot after this feature lands: PG has no resetAt yet.  Push the
    // local one (stamped by init.js when openDb() first ran) into PG so all
    // subsequent restarts see the same durable value.
    if (!restoredResetAt) {
      const localRow = db.prepare(
        `SELECT value FROM failures_meta WHERE key = 'resetAt'`
      ).get();
      if (localRow) {
        await pool.query(
          `INSERT INTO failures_meta (key, value) VALUES ('resetAt', $1)
             ON CONFLICT (key) DO NOTHING`,
          [localRow.value]
        );
      }
    }

    db.close();
    const completedAt = new Date().toISOString();
    console.log(
      `[pg-failures] Restore complete — ${rows.length} PG row(s), ${inserted} new into SQLite, resetAt ${restoredResetAt ? 'restored from PG' : 'seeded into PG'}.`
    );
    writeRestoreStatus({
      ok:           true,
      restoredAt:   completedAt,
      startedAt,
      restoredRows: rows.length,
      insertedRows: inserted,
      error:        null,
    });
  } catch (err) {
    console.error('[pg-failures] restore failed (non-fatal, history will start empty):', err.message);
    writeRestoreStatus({
      ok:           false,
      restoredAt:   new Date().toISOString(),
      startedAt,
      restoredRows: 0,
      insertedRows: 0,
      error:        err.message,
    });
  }
}

// Wipe PG failure history and stamp a fresh resetAt, mirroring the local
// clearFailures() transaction.  Fire-and-forget from the API handler.
async function clearFailuresInPg() {
  if (!process.env.DATABASE_URL) return;
  try {
    await ensurePgFailuresSchema();
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM failures');
      await client.query(
        `INSERT INTO failures_meta (key, value) VALUES ('resetAt', $1)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [new Date().toISOString()]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[pg-failures] clear failed (non-fatal):', err.message);
  }
}

module.exports = {
  ensurePgFailuresSchema,
  mirrorFailureToPg,
  restoreFailuresFromPg,
  clearFailuresInPg,
  getRestoreStatus,
};
