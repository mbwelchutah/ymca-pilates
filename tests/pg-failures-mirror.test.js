/**
 * Task #86 — failure history must survive container redeploys.
 *
 * SQLite (where failures are recorded) is gitignored on Replit and rebuilt
 * from scratch on every publish, so the structured failure log used to vanish
 * after each deploy.  We now mirror every failure row to PostgreSQL through
 * `src/db/pg-failures.js` and restore them back into a fresh SQLite at
 * startup (driven by pg-init.js).
 *
 * This test exercises the round-trip directly:
 *   1. record a failure → assert it lands in PG
 *   2. wipe SQLite      → assert restoreFailuresFromPg() repopulates it
 *   3. clearFailures()  → assert the PG mirror is also wiped
 *
 * The tests are skipped automatically when DATABASE_URL is not set so they
 * stay green on contributor machines without a Postgres handy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

let tmpDbPath;
let originalSqlitePath;
let pool;

async function freshPgSchema() {
  const { ensurePgFailuresSchema } = require('../src/db/pg-failures');
  await ensurePgFailuresSchema();
  await pool.query('DELETE FROM failures');
  await pool.query(`DELETE FROM failures_meta WHERE key = 'resetAt'`);
}

beforeEach(async () => {
  tmpDbPath = path.join(os.tmpdir(), `pg-failures-${process.pid}-${Date.now()}.db`);
  originalSqlitePath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = tmpDbPath;

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/db/')) delete require.cache[key];
  }

  if (HAS_PG) {
    const { Pool } = require('pg');
    let ssl = false;
    try {
      const h = new URL(process.env.DATABASE_URL).hostname;
      if (h.includes('.')) ssl = { rejectUnauthorized: false };
    } catch {}
    pool = new Pool({ ssl });
    await freshPgSchema();
  }
});

afterEach(async () => {
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = originalSqlitePath;
  if (pool) { await pool.end().catch(() => {}); pool = null; }
});

d('failure-log PG mirror — Task #86', () => {
  it('mirrors a recorded failure to PostgreSQL via recordFailure dispatch', async () => {
    const { recordFailure } = require('../src/db/failures');

    const marker = `mirror-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    recordFailure({
      jobId: 42, phase: 'verify', reason: 'modal_time_mismatch',
      message: marker, classTitle: 'Yoga', screenshot: null,
    });

    // recordFailure dispatches the PG mirror fire-and-forget; poll until the
    // row appears (or fail after a generous timeout) so we are validating the
    // exact row emitted by the synchronous public API, not a separate write.
    const deadline = Date.now() + 5_000;
    let row = null;
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT job_id, phase, reason, message, class_title
           FROM failures WHERE message = $1 LIMIT 1`,
        [marker]
      );
      if (rows.length) { row = rows[0]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(row).not.toBeNull();
    expect(row.job_id).toBe(42);
    expect(row.phase).toBe('verify');
    expect(row.reason).toBe('modal_time_mismatch');
    expect(row.class_title).toBe('Yoga');
  });

  it('restoreFailuresFromPg repopulates a fresh SQLite from PG', async () => {
    // Seed PG directly with a row that SQLite has never seen.
    const occurredAt = '2026-01-15T12:00:00.000Z';
    await pool.query(
      `INSERT INTO failures
         (job_id, occurred_at, phase, reason, message, class_title)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [7, occurredAt, 'click', 'click_fallback', 'restore-test', 'Pilates']
    );
    await pool.query(
      `INSERT INTO failures_meta (key, value) VALUES ('resetAt', $1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ['2026-01-01T00:00:00.000Z']
    );

    const { restoreFailuresFromPg } = require('../src/db/pg-failures');
    await restoreFailuresFromPg();

    const { getRecentFailures, getFailuresResetAt } = require('../src/db/failures');
    const recent = getRecentFailures(20);
    expect(recent.some(r => r.message === 'restore-test')).toBe(true);
    expect(getFailuresResetAt()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('restore is idempotent — running twice does not duplicate rows', async () => {
    await pool.query(
      `INSERT INTO failures (occurred_at, phase, reason, message)
       VALUES ($1, 'auth', 'login_failed', 'idem-test')`,
      ['2026-02-01T00:00:00.000Z']
    );
    const { restoreFailuresFromPg } = require('../src/db/pg-failures');
    await restoreFailuresFromPg();
    await restoreFailuresFromPg();

    const { getRecentFailures } = require('../src/db/failures');
    const matches = getRecentFailures(20).filter(r => r.message === 'idem-test');
    expect(matches.length).toBe(1);
  });

  it('clearFailures wipes the PG mirror and advances PG resetAt', async () => {
    const { mirrorFailureToPg, clearFailuresInPg } = require('../src/db/pg-failures');
    await mirrorFailureToPg({
      job_id: null, occurred_at: new Date().toISOString(),
      phase: 'scan', reason: 'class_not_found', message: 'clear-test',
    });
    let { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM failures`);
    expect(rows[0].n).toBeGreaterThan(0);

    await clearFailuresInPg();
    ({ rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM failures`));
    expect(rows[0].n).toBe(0);
    const meta = await pool.query(`SELECT value FROM failures_meta WHERE key = 'resetAt'`);
    expect(meta.rows.length).toBe(1);
    expect(typeof meta.rows[0].value).toBe('string');
  });
});
