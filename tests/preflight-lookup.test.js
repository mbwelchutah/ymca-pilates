/**
 * Coverage for the preflight lookup-miss differentiation added in Task #68.
 *
 * The /api/preflight endpoint must distinguish three lookup-miss outcomes
 * before it ever launches the booking pipeline, so the UI can render an
 * honest, actionable message instead of a generic "step failed":
 *
 *   JOB_GONE       — jobId sent but the row no longer exists
 *   JOB_INACTIVE   — jobId sent and row exists but is_active=0
 *   NO_ACTIVE_JOBS — no jobId sent and no active jobs exist
 *
 * Each response must include code, message, requestedJobId, and currentJobIds
 * so we can forensically correlate vanish-cycles between SQLite/PG/seed-jobs.
 *
 * Spawns a real server on a dedicated port (5098) and exercises the live HTTP
 * route — no booking pipeline is reached because the lookup miss short-circuits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn }                                     from 'child_process';
import http                                          from 'http';
import fs                                            from 'fs';
import path                                          from 'path';
import { fileURLToPath }                             from 'url';
import { createRequire }                             from 'module';

const _require   = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH  = path.resolve(__dirname, '../data/seed-jobs.json');
const SEED_BAK   = SEED_PATH + '.preflight-lookup-test-bak';
const TEST_PORT  = 5098;

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
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('request timed out')); });
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

describe('API: /api/preflight lookup-miss codes (Task #68)', () => {
  let serverProcess;
  let openDb;
  let inactiveJobId;
  let preExistingActiveIds = [];

  beforeAll(async () => {
    ({ openDb } = _require('../src/db/init'));
    const db = openDb();

    if (fs.existsSync(SEED_PATH)) fs.copyFileSync(SEED_PATH, SEED_BAK);

    db.prepare("DELETE FROM jobs WHERE class_title LIKE 'PREFLIGHT_LOOKUP_%'").run();

    // Snapshot any pre-existing active jobs so the NO_ACTIVE_JOBS test can
    // toggle them off temporarily and restore them afterward — we must not
    // mutate the user's real plan data.
    preExistingActiveIds = db
      .prepare("SELECT id FROM jobs WHERE is_active = 1")
      .all()
      .map(r => r.id);

    inactiveJobId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'PREFLIGHT_LOOKUP_INACTIVE', 'T', 'Friday', '7:00 AM', null, 0,
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
      db.prepare("DELETE FROM jobs WHERE class_title LIKE 'PREFLIGHT_LOOKUP_%'").run();
      // Restore any actives we may have disabled in the NO_ACTIVE_JOBS test.
      for (const id of preExistingActiveIds) {
        db.prepare('UPDATE jobs SET is_active = 1 WHERE id = ?').run(id);
      }
    } catch { /* ignore */ }
    if (fs.existsSync(SEED_BAK)) fs.renameSync(SEED_BAK, SEED_PATH);
  });

  it('returns code=JOB_GONE for an unknown jobId without launching the pipeline', async () => {
    const r = await request('POST', '/api/preflight', { jobId: 99_999_999 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      success:        false,
      code:           'JOB_GONE',
      requestedJobId: 99_999_999,
    });
    expect(typeof r.json.message).toBe('string');
    expect(r.json.message.length).toBeGreaterThan(0);
    expect(Array.isArray(r.json.currentJobIds)).toBe(true);
  });

  it('returns code=JOB_INACTIVE for an existing but disabled job', async () => {
    const r = await request('POST', '/api/preflight', { jobId: inactiveJobId });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      success:        false,
      code:           'JOB_INACTIVE',
      requestedJobId: inactiveJobId,
    });
    expect(r.json.currentJobIds).toContain(inactiveJobId);
  });

  it('returns code=NO_ACTIVE_JOBS when no jobId sent and nothing is active', async () => {
    const db = openDb();
    // Temporarily deactivate any currently-active rows so the implicit-active
    // lookup branch finds nothing.  Restored in afterAll.
    db.prepare('UPDATE jobs SET is_active = 0 WHERE is_active = 1').run();
    try {
      const r = await request('POST', '/api/preflight', {});
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        success: false,
        code:    'NO_ACTIVE_JOBS',
      });
      expect(Array.isArray(r.json.currentJobIds)).toBe(true);
    } finally {
      for (const id of preExistingActiveIds) {
        db.prepare('UPDATE jobs SET is_active = 1 WHERE id = ?').run(id);
      }
    }
  });
});
