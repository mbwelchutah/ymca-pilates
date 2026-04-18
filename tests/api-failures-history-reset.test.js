/**
 * Task #82 — failure history is wiped on every container redeploy (SQLite is
 * gitignored on Replit and rebuilt from seed-jobs.json on each restart).  To
 * stop the Failure Insights panel from implying durable all-time history, the
 * server now exposes a `historyResetAt` ISO timestamp on GET /api/failures.
 *
 * It is set:
 *   - the first time openDb() runs against a fresh SQLite file (deploy /
 *     restart), and
 *   - on every clearFailures() / DELETE /api/failures call.
 *
 * This test exercises the round-trip directly through the failures.js API
 * against an isolated SQLite file (SQLITE_PATH env var) so it doesn't disturb
 * the dev DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import os   from 'os';
import path from 'path';

let tmpDbPath;
let originalSqlitePath;

beforeEach(() => {
  tmpDbPath = path.join(os.tmpdir(), `failures-reset-${process.pid}-${Date.now()}.db`);
  originalSqlitePath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = tmpDbPath;
  // Force a fresh require so init.js / failures.js pick up the new path and
  // the seed-sync once-per-process guard doesn't carry over between tests.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/src/db/')) delete require.cache[key];
  }
});

afterEach(() => {
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  if (originalSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = originalSqlitePath;
});

describe('failures_meta.resetAt — Task #82', () => {
  it('is stamped on first openDb() against a fresh SQLite file', async () => {
    const { getFailuresResetAt } = require('../src/db/failures');
    const before = Date.now();
    const ts     = getFailuresResetAt();
    const after  = Date.now();

    expect(ts).toBeTruthy();
    expect(typeof ts).toBe('string');
    const tsMs = new Date(ts).getTime();
    expect(tsMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(tsMs).toBeLessThanOrEqual(after + 1_000);
  });

  it('survives a second openDb() within the same process (not overwritten)', async () => {
    const { getFailuresResetAt } = require('../src/db/failures');
    const first  = getFailuresResetAt();
    // Tiny wait to ensure a new ISO string would differ.
    await new Promise(r => setTimeout(r, 25));
    const second = getFailuresResetAt();
    expect(second).toBe(first);
  });

  it('is updated to a fresh timestamp by clearFailures()', async () => {
    const { getFailuresResetAt, clearFailures } = require('../src/db/failures');
    const initial = getFailuresResetAt();
    await new Promise(r => setTimeout(r, 25));
    clearFailures();
    const after = getFailuresResetAt();
    expect(after).toBeTruthy();
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(initial).getTime());
  });
});
