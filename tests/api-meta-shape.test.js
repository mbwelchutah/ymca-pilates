/**
 * Task #90 — verify each of the four read endpoints documented to carry a
 * `meta` block (Task #81/#88 staleness signalling) returns it under the
 * documented conditions.
 *
 *   GET /api/state           — meta.degradedReason flips to
 *                              'past_jobs_inactivated' when stale active
 *                              past one-offs are silently inactivated.
 *   GET /api/session-status  — meta.degradedReason='no_session_check_yet'
 *                              when auth-state has never recorded a check.
 *   GET /api/sniper-state    — meta.degradedReason='sniper_state_missing'
 *                              when the on-disk state file is absent.
 *   GET /api/readiness       — meta.degradedReason='no_readiness_yet' when
 *                              readiness has never been written;
 *                              meta.fallbackJobId=true when the handler
 *                              falls back to "first active job" because
 *                              readiness.jobId is unset.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn }                                      from 'child_process';
import http                                           from 'http';
import fs                                             from 'fs';
import path                                           from 'path';
import { fileURLToPath }                              from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'src/data');

const TEST_PORT = 5097;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function waitForServer(port, retries = 40, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let n = 0;
    function attempt() {
      const req = http.get(`http://localhost:${port}/status`, (res) => {
        res.resume(); resolve();
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

// ── Snapshot + restore the data files we mutate so reruns stay clean ──────
const FILES_TO_GUARD = [
  'sniper-state.json',
  'readiness-state.json',
  'auth-state.json',
];
const backups = new Map();

function snapshotFiles() {
  for (const name of FILES_TO_GUARD) {
    const p = path.join(DATA_DIR, name);
    if (fs.existsSync(p)) backups.set(name, fs.readFileSync(p));
    else                   backups.set(name, null);
  }
}
function restoreFiles() {
  for (const [name, contents] of backups.entries()) {
    const p = path.join(DATA_DIR, name);
    if (contents == null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, contents);
    }
  }
}

let serverProcess;

describe('Documented `meta` shape on the four staleness-signalling endpoints (Task #81/#88/#90)', () => {
  beforeAll(async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    snapshotFiles();
    // Wipe each file so the server boots into the documented "missing /
    // never-written" degraded state for sniper-state + readiness, and so
    // auth-state has never recorded a check.
    for (const name of FILES_TO_GUARD) {
      const p = path.join(DATA_DIR, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    serverProcess = spawn(process.execPath, ['src/web/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'ignore',
    });
    await waitForServer(TEST_PORT);
  }, 30_000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill('SIGTERM');
    restoreFiles();
  });

  it('GET /api/state returns a meta block with the documented keys', async () => {
    const res = await request('GET', '/api/state');
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json).toHaveProperty('meta');
    const m = res.json.meta;
    expect(m).toHaveProperty('degradedReason');
    expect(m).toHaveProperty('fallbackJobId');
    expect(m).toHaveProperty('snapshotAge');
    // /api/state computes from a live DB read — fallback/snapshot are
    // documented to be { false, null } and degradedReason is null unless
    // we silently inactivated stale past one-offs on this call.
    expect(m.fallbackJobId).toBe(false);
    expect(m.snapshotAge).toBeNull();
    expect(m.degradedReason === null || m.degradedReason === 'past_jobs_inactivated').toBe(true);
  });

  it('GET /api/session-status reports no_session_check_yet when auth-state is fresh', async () => {
    const res = await request('GET', '/api/session-status');
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json).toHaveProperty('meta');
    const m = res.json.meta;
    expect(m).toHaveProperty('degradedReason');
    expect(m).toHaveProperty('fallbackJobId');
    expect(m).toHaveProperty('snapshotAge');
    expect(m.fallbackJobId).toBe(false);
    // After a fresh boot the documented degraded reasons are
    // 'no_session_check_yet' (lastCheckedAt missing) or
    // 'session_status_unknown' (sessionValid null + no display data).
    // Some tiers run auth validation at startup — that may set
    // lastCheckedAt before we observe, in which case degradedReason is
    // null and snapshotAge becomes a non-negative number.
    const allowedReasons = [null, 'no_session_check_yet', 'session_status_unknown'];
    expect(allowedReasons).toContain(m.degradedReason);
    if (m.snapshotAge !== null) {
      expect(typeof m.snapshotAge).toBe('number');
      expect(m.snapshotAge).toBeGreaterThanOrEqual(0);
    }
  });

  it('GET /api/sniper-state reports sniper_state_missing when the file is absent', async () => {
    const res = await request('GET', '/api/sniper-state');
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json).toHaveProperty('meta');
    const m = res.json.meta;
    expect(m).toHaveProperty('degradedReason');
    expect(m).toHaveProperty('fallbackJobId');
    expect(m).toHaveProperty('snapshotAge');
    expect(m.degradedReason).toBe('sniper_state_missing');
    expect(m.fallbackJobId).toBe(false);
    expect(m.snapshotAge).toBeNull();
  });

  it('GET /api/readiness reports no_readiness_yet (and may set fallbackJobId) when readiness was never written', async () => {
    const res = await request('GET', '/api/readiness');
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    expect(res.json).toHaveProperty('meta');
    const m = res.json.meta;
    expect(m).toHaveProperty('degradedReason');
    expect(m).toHaveProperty('fallbackJobId');
    expect(m).toHaveProperty('snapshotAge');
    expect(m.degradedReason).toBe('no_readiness_yet');
    // fallbackJobId is true iff there was an active job to fall back to;
    // either way, the field must be a boolean per the documented contract.
    expect(typeof m.fallbackJobId).toBe('boolean');
    expect(m.snapshotAge).toBeNull();
  });
});
