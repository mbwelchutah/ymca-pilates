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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs    from 'fs';
import os    from 'os';
import path  from 'path';
import http  from 'http';
import { spawn }            from 'child_process';
import { fileURLToPath }    from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── API-level coverage ──────────────────────────────────────────────────────
// Spawns the real server and asserts GET /api/failures returns historyResetAt
// in the response envelope, and that DELETE /api/failures advances it.

const TEST_PORT = 5098;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function deleteUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'DELETE' },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function waitForServer(port, retries = 20, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let n = 0;
    function attempt() {
      const req = http.get(`http://localhost:${port}/api/failures`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++n >= retries) { reject(new Error(`Server did not start on port ${port}`)); return; }
        setTimeout(attempt, delayMs);
      });
      req.setTimeout(500, () => { req.destroy(); });
    }
    attempt();
  });
}

describe('GET /api/failures — historyResetAt envelope (Task #82)', () => {
  let serverProcess;

  beforeAll(async () => {
    serverProcess = spawn(process.execPath, ['src/web/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'ignore',
    });
    await waitForServer(TEST_PORT);
  }, 30_000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill('SIGTERM');
  });

  it('includes historyResetAt as a non-null ISO timestamp on a fresh server', async () => {
    const data = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    expect(data).toHaveProperty('historyResetAt');
    expect(typeof data.historyResetAt).toBe('string');
    // Must be parseable as a valid Date.
    expect(Number.isNaN(new Date(data.historyResetAt).getTime())).toBe(false);
  });

  it('historyResetAt advances after DELETE /api/failures', async () => {
    const before = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    await new Promise(r => setTimeout(r, 25));
    await deleteUrl(`http://localhost:${TEST_PORT}/api/failures`);
    const after = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    expect(new Date(after.historyResetAt).getTime())
      .toBeGreaterThan(new Date(before.historyResetAt).getTime());
  });
});
