// Task #68 — three-store integrity audit.
//
// Compares the job set in SQLite, PostgreSQL, and data/seed-jobs.json by an
// identity tuple (class_title + day_of_week + class_time + target_date) and
// logs a structured warning if the three stores disagree.  This does NOT
// auto-resolve drift — its job is to make drift loudly visible at boot so we
// can correlate the "card disappeared and came back" cycle with the actual
// store-by-store divergence.
//
// Called from src/web/server.js once at startup, after pg-init has refreshed
// seed-jobs.json from PostgreSQL and openDb() has seeded SQLite from the
// seed file.  Runs entirely best-effort: any failure is logged and swallowed
// (drift detection must never break the boot path).

const fs   = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '../../data/seed-jobs.json');

function _identityTuple(j) {
  return [
    j.class_title  ?? '',
    j.day_of_week  ?? '',
    j.class_time   ?? '',
    j.target_date  ?? '',
  ].join('|');
}

function _readSqliteJobs() {
  try {
    const { openDb } = require('./init');
    const db = openDb();
    return db.prepare(
      'SELECT class_title, day_of_week, class_time, target_date, is_active FROM jobs'
    ).all();
  } catch (e) {
    return { _err: e.message };
  }
}

async function _readPgJobs() {
  if (!process.env.DATABASE_URL) return { _err: 'DATABASE_URL not set' };
  try {
    const { Pool } = require('pg');
    let sslOpt = false;
    try {
      const h = new URL(process.env.DATABASE_URL).hostname;
      if (h.includes('.')) sslOpt = { rejectUnauthorized: false };
    } catch (_) { /* ignore */ }
    const pool = new Pool({ ssl: sslOpt });
    try {
      const { rows } = await pool.query(
        'SELECT class_title, day_of_week, class_time, target_date, is_active FROM jobs'
      );
      return rows;
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (e) {
    return { _err: e.message };
  }
}

function _readSeedJobs() {
  try {
    if (!fs.existsSync(SEED_PATH)) return [];
    return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (e) {
    return { _err: e.message };
  }
}

// Pure helper used by tests — given the three job arrays, returns either null
// (in sync) or a structured drift report.
function diffStores(sqlite, pg, seed) {
  const sqliteSet = new Set(sqlite.map(_identityTuple));
  const pgSet     = new Set(pg.map(_identityTuple));
  const seedSet   = new Set(seed.map(_identityTuple));

  const all = new Set([...sqliteSet, ...pgSet, ...seedSet]);
  const drift = [];
  for (const t of all) {
    const inS = sqliteSet.has(t);
    const inP = pgSet.has(t);
    const inJ = seedSet.has(t);
    if (!(inS && inP && inJ)) {
      drift.push({ tuple: t, sqlite: inS, pg: inP, seed: inJ });
    }
  }
  if (drift.length === 0) return null;
  return {
    counts: { sqlite: sqliteSet.size, pg: pgSet.size, seed: seedSet.size },
    drift,
  };
}

async function runIntegrityAudit() {
  try {
    const sqlite = _readSqliteJobs();
    const pg     = await _readPgJobs();
    const seed   = _readSeedJobs();

    if (sqlite?._err || pg?._err || seed?._err) {
      console.warn('[integrity-audit] skipped — could not read all stores:',
        JSON.stringify({
          sqliteErr: sqlite?._err ?? null,
          pgErr:     pg?._err     ?? null,
          seedErr:   seed?._err   ?? null,
        })
      );
      return;
    }

    const report = diffStores(sqlite, pg, seed);
    if (!report) {
      console.log(`[integrity-audit] OK — SQLite/PG/seed-jobs all agree (${sqlite.length} job(s)).`);
      return;
    }

    console.warn(
      `[integrity-audit] DRIFT DETECTED — counts ${JSON.stringify(report.counts)}; ` +
      `${report.drift.length} identity tuple(s) differ between stores. ` +
      `This can cause "card disappeared and came back" cycles. Investigate before booking-critical edits.`
    );
    for (const d of report.drift) {
      console.warn(
        `[integrity-audit]   tuple="${d.tuple}" sqlite=${d.sqlite} pg=${d.pg} seed=${d.seed}`
      );
    }
  } catch (e) {
    console.warn('[integrity-audit] unexpected error (non-fatal):', e.message);
  }
}

module.exports = { runIntegrityAudit, diffStores };
