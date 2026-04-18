/**
 * Coverage for the past-class behavior added to the scheduler / web layer:
 *
 *   A) isPastClass() boundary in Pacific time
 *      - a class today at 11:59 PM is NOT passed at noon today
 *      - a class today at 12:01 AM IS passed at noon today
 *      - a recurring job (no target_date) is never passed
 *
 *   B) advanceJobOneWeek() jumps in 7-day steps until the new date+time is
 *      strictly in the future, and reactivates the job.
 *
 *   C) POST /api/jobs/:id/advance  — success / recurring 409 / 404
 *   D) POST /toggle-active         — 409 when activating a past one-off
 *
 * Unit tests use vi.useFakeTimers() so Date.now() is deterministic.  API tests
 * spawn the real server on a dedicated port and exercise the live HTTP routes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn }                                                                  from 'child_process';
import http                                                                       from 'http';
import fs                                                                         from 'fs';
import path                                                                       from 'path';
import { fileURLToPath }                                                          from 'url';
import { createRequire }                                                          from 'module';

const _require    = createRequire(import.meta.url);
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH   = path.resolve(__dirname, '../data/seed-jobs.json');
const SEED_BACKUP = SEED_PATH + '.past-class-test-bak';

// Noon Pacific Daylight Time on a known PDT date (UTC-7).
//   2026-06-15 12:00 PDT === 2026-06-15 19:00 UTC
const NOON_PDT_UTC = new Date('2026-06-15T19:00:00.000Z');

// ---------------------------------------------------------------------------
// A) isPastClass — Pacific time boundary
// ---------------------------------------------------------------------------
describe('isPastClass — Pacific time boundary', () => {
  let isPastClass;

  beforeAll(() => {
    ({ isPastClass } = _require('../src/scheduler/booking-window'));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_PDT_UTC);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a class today at 11:59 PM (still hours away)', () => {
    const job = {
      class_title: 'Late Night',
      day_of_week: 'Monday',
      class_time:  '11:59 PM',
      target_date: '2026-06-15',
    };
    expect(isPastClass(job)).toBe(false);
  });

  it('returns true for a class today at 12:01 AM (already past)', () => {
    const job = {
      class_title: 'Early Bird',
      day_of_week: 'Monday',
      class_time:  '12:01 AM',
      target_date: '2026-06-15',
    };
    expect(isPastClass(job)).toBe(true);
  });

  it('returns false for a recurring job (no target_date) regardless of class_time', () => {
    const job = {
      class_title: 'Recurring',
      day_of_week: 'Monday',
      class_time:  '6:00 AM',
      target_date: null,
    };
    expect(isPastClass(job)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B) advanceJobOneWeek — 7-day stepping into the future
// ---------------------------------------------------------------------------
describe('advanceJobOneWeek — 7-day stepping', () => {
  let advanceJobOneWeek, openDb, insertedId;

  beforeAll(() => {
    ({ advanceJobOneWeek } = _require('../src/db/jobs'));
    ({ openDb }            = _require('../src/db/init'));
    // Snapshot seed-jobs.json so the syncSeed() side-effect of
    // advanceJobOneWeek() doesn't pollute the checked-in seed file.
    if (fs.existsSync(SEED_PATH)) fs.copyFileSync(SEED_PATH, SEED_BACKUP);
  });

  afterAll(() => {
    if (fs.existsSync(SEED_BACKUP)) fs.renameSync(SEED_BACKUP, SEED_PATH);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_PDT_UTC);

    const db = openDb();
    db.prepare("DELETE FROM jobs WHERE class_title = 'PASTTEST_ADVANCE'").run();
    insertedId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'PASTTEST_ADVANCE', 'T', 'Monday', '7:00 AM', '2026-06-01', 0,
      new Date().toISOString()
    ).lastInsertRowid;
  });

  afterEach(() => {
    vi.useRealTimers();
    const db = openDb();
    if (insertedId) db.prepare('DELETE FROM jobs WHERE id = ?').run(insertedId);
    insertedId = null;
  });

  it('advances target_date by exact 7-day multiples until strictly future, and reactivates', () => {
    // Now is 2026-06-15 12:00 PDT.  Class at 7:00 AM means:
    //   06-01 past, 06-08 past, 06-15 past (7am < noon), 06-22 future.
    // Expect three 7-day bumps → 2026-06-22.
    const updated = advanceJobOneWeek(insertedId);
    expect(updated).not.toBeNull();
    expect(updated.target_date).toBe('2026-06-22');
    expect(updated.is_active).toBe(1);

    // Sanity: the diff from the original date is exactly 21 days (3 × 7).
    const orig = new Date('2026-06-01T12:00:00Z');
    const next = new Date(updated.target_date + 'T12:00:00Z');
    const diffDays = Math.round((next - orig) / 86_400_000);
    expect(diffDays % 7).toBe(0);
    expect(diffDays).toBe(21);
  });

  it('returns null for a missing job id', () => {
    expect(advanceJobOneWeek(99_999_999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C/D) HTTP-level coverage of /api/jobs/:id/advance and /toggle-active
// ---------------------------------------------------------------------------
const TEST_PORT = 5097;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port:     TEST_PORT,
      path:     urlPath,
      method,
      headers:  data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: chunks, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error('request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

function waitForServer(port, retries = 30, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      const r = http.get(`http://localhost:${port}/api/jobs`, (res) => {
        res.resume();
        resolve();
      });
      r.on('error', () => {
        if (++attempts >= retries) return reject(new Error('server did not start'));
        setTimeout(attempt, delayMs);
      });
      r.setTimeout(500, () => { r.destroy(); });
    };
    attempt();
  });
}

describe('API: past-class endpoints', () => {
  let serverProcess;
  let openDb;
  let pastJobId, recurringJobId;

  beforeAll(async () => {
    ({ openDb } = _require('../src/db/init'));
    const db = openDb();

    // Snapshot seed-jobs.json so the API tests' syncSeed() side-effects
    // (triggered by /api/jobs/:id/advance) can be rolled back in afterAll.
    if (fs.existsSync(SEED_PATH)) fs.copyFileSync(SEED_PATH, SEED_BACKUP);

    // Clean any leftovers from prior runs.
    db.prepare("DELETE FROM jobs WHERE class_title LIKE 'PASTTEST_API_%'").run();

    // A clearly-past one-off class — used by both advance-success and toggle-409.
    // Use a date 60 days in the (real) past so advanceJobOneWeek's 520-bump
    // cap is never an issue regardless of when CI runs.
    const pastIso = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    pastJobId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'PASTTEST_API_PAST', 'T', 'Friday', '7:00 AM', pastIso, 0,
      new Date().toISOString()
    ).lastInsertRowid;

    // A recurring class (no target_date) — used to assert the 409 reject path
    // of the advance endpoint.
    recurringJobId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'PASTTEST_API_RECURRING', 'T', 'Wednesday', '7:00 AM', null, 0,
      new Date().toISOString()
    ).lastInsertRowid;

    serverProcess = spawn(process.execPath, ['src/web/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'ignore',
    });

    await waitForServer(TEST_PORT);
  }, 30_000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill('SIGTERM');
    try {
      const db = openDb();
      db.prepare("DELETE FROM jobs WHERE class_title LIKE 'PASTTEST_API_%'").run();
    } catch { /* ignore */ }
    // Restore seed-jobs.json so test rows don't pollute the seed file.
    if (fs.existsSync(SEED_BACKUP)) {
      fs.renameSync(SEED_BACKUP, SEED_PATH);
    }
  });

  it('POST /api/jobs/:id/advance — 404 for a missing job', async () => {
    const r = await request('POST', '/api/jobs/99999999/advance');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ success: false });
  });

  it('POST /api/jobs/:id/advance — 409 for a recurring (no target_date) job', async () => {
    const r = await request('POST', `/api/jobs/${recurringJobId}/advance`);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false });
    expect(String(r.json.error || '')).toMatch(/recurring/i);
  });

  it('POST /toggle-active — 409 when activating a past one-off class', async () => {
    const r = await request('POST', '/toggle-active', { id: pastJobId, is_active: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false, is_active: false });
    expect(String(r.json.error || '')).toMatch(/passed/i);

    // Storage must remain inactive — the guard rejected the flip.
    const db    = openDb();
    const after = db.prepare('SELECT is_active FROM jobs WHERE id = ?').get(pastJobId);
    expect(after.is_active).toBe(0);
  });

  it('POST /api/jobs/:id/advance — success path moves target_date strictly forward and reactivates', async () => {
    // Note: this runs after the toggle-409 test.  The job is still past and
    // inactive — advancing must roll target_date to a future date and flip
    // is_active back to 1.
    const before = openDb().prepare('SELECT target_date FROM jobs WHERE id = ?').get(pastJobId).target_date;

    const r = await request('POST', `/api/jobs/${pastJobId}/advance`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true });
    expect(r.json.job).toBeTruthy();
    expect(r.json.job.target_date).not.toBe(before);
    expect(r.json.job.is_active).toBe(1);
    expect(r.json.job.passed).toBe(false);

    // 7-day-step invariant: difference between old and new target_date is a
    // multiple of 7 days.
    const oldD = new Date(before + 'T12:00:00Z');
    const newD = new Date(r.json.job.target_date + 'T12:00:00Z');
    const diffDays = Math.round((newD - oldD) / 86_400_000);
    expect(diffDays).toBeGreaterThan(0);
    expect(diffDays % 7).toBe(0);

    // And the new date must be in the (real) future.
    expect(newD.getTime()).toBeGreaterThan(Date.now());
  });
});
