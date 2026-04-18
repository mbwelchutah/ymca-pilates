/**
 * Task #83 — destructive endpoints must not be triggered by a stray GET.
 *
 * `/clean-test-jobs`, `/run-job`, and `/register` were historically
 * exposed as GET handlers. Anything that can prefetch a URL — a browser
 * address-bar suggestion, a link scanner, a service-worker warm-up —
 * could fire them. They are now POST-only:
 *   - GET returns 405 + Allow: POST and does NOT mutate state.
 *   - `/clean-test-jobs` additionally requires `{ confirm: true }` in
 *     the JSON body, matching the existing
 *     `/api/recovery/clear-transient` convention. Missing/false
 *     confirm → 400 + readable message, no rows deleted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http  from 'http';
import path  from 'path';
import { spawn }         from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PORT = 5099;

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
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function waitForServer(port, retries = 30, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let n = 0;
    function attempt() {
      const req = http.get(`http://localhost:${port}/status`, (res) => {
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

describe('Destructive endpoints reject GET (Task #83)', () => {
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

  for (const route of ['/clean-test-jobs', '/run-job', '/register']) {
    it(`GET ${route} returns 405 Method Not Allowed with Allow: POST`, async () => {
      const res = await request('GET', route);
      expect(res.status).toBe(405);
      expect(String(res.headers.allow || '').toUpperCase()).toContain('POST');
      expect(res.json).toBeTruthy();
      expect(res.json.success).toBe(false);
    });
  }

  it('GET /clean-test-jobs does not delete jobs (count is unchanged)', async () => {
    const before = await request('GET', '/api/jobs');
    const beforeCount = Array.isArray(before.json?.jobs)
      ? before.json.jobs.length
      : (Array.isArray(before.json) ? before.json.length : null);
    expect(beforeCount).not.toBeNull();

    const stray = await request('GET', '/clean-test-jobs');
    expect(stray.status).toBe(405);

    const after = await request('GET', '/api/jobs');
    const afterCount = Array.isArray(after.json?.jobs)
      ? after.json.jobs.length
      : (Array.isArray(after.json) ? after.json.length : null);
    expect(afterCount).toBe(beforeCount);
  });

  it('POST /clean-test-jobs without confirm returns 400 and does not mutate', async () => {
    const before = await request('GET', '/api/jobs');
    const beforeCount = Array.isArray(before.json?.jobs)
      ? before.json.jobs.length
      : (Array.isArray(before.json) ? before.json.length : null);

    const res = await request('POST', '/clean-test-jobs', {});
    expect(res.status).toBe(400);
    expect(res.json?.success).toBe(false);
    expect(String(res.json?.message || '').toLowerCase()).toContain('confirm');

    const after = await request('GET', '/api/jobs');
    const afterCount = Array.isArray(after.json?.jobs)
      ? after.json.jobs.length
      : (Array.isArray(after.json) ? after.json.length : null);
    expect(afterCount).toBe(beforeCount);
  });

  it('POST /clean-test-jobs with confirm:true returns 200 success envelope', async () => {
    const res = await request('POST', '/clean-test-jobs', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    expect(typeof res.json?.log).toBe('string');
  });
});
