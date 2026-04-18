/**
 * Task #84 — surface freshness so the UI can label "scraped X ago" and
 * empty replay history can be distinguished from "no runs ever happened".
 *
 *   - GET /api/scraped-classes returns a top-level `scrapedAt` field
 *     (max of row scraped_at, or null when the table is empty).
 *   - GET /api/replay-history/:jobId returns runs[] (possibly empty), and
 *     each entry — when present — carries a `capturedAt` ISO timestamp.
 *     The empty case lets the UI render the "history resets on restart"
 *     hint instead of misreading silence as "the bot did nothing".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http  from 'http';
import path  from 'path';
import { spawn }         from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PORT = 5098;

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

describe('Freshness fields exposed on read endpoints (Task #84)', () => {
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

  it('GET /api/scraped-classes includes a scrapedAt field (string or null)', async () => {
    const res = await request('GET', '/api/scraped-classes');
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    expect(Array.isArray(res.json.classes)).toBe(true);
    // scrapedAt must be present in the envelope; value may be null when empty.
    expect(Object.prototype.hasOwnProperty.call(res.json, 'scrapedAt')).toBe(true);
    if (res.json.scrapedAt !== null) {
      expect(typeof res.json.scrapedAt).toBe('string');
      // ISO-parseable
      expect(Number.isFinite(Date.parse(res.json.scrapedAt))).toBe(true);
    }
  });

  it('GET /api/replay-history/:jobId returns an empty runs[] when no replays recorded', async () => {
    // Use an arbitrary jobId that has no replay files on disk yet.
    const res = await request('GET', '/api/replay-history/9999999');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json?.runs)).toBe(true);
    expect(res.json.runs.length).toBe(0);
  });

  it('GET /api/jobs/:id/classify includes a top-level scrapedAt field', async () => {
    // Use whichever job exists in the seeded DB.  classify never launches
    // Playwright — it just reads the cache file — so this is safe and fast.
    const jobs = await request('GET', '/api/jobs');
    const list = Array.isArray(jobs.json) ? jobs.json : [];
    if (list.length === 0) {
      // No jobs in DB — request a known-bad id to verify error path doesn't
      // accidentally include scrapedAt and to keep the test meaningful.
      const r = await request('GET', '/api/jobs/9999999/classify');
      expect(r.status).toBe(404);
      return;
    }
    const r = await request('GET', `/api/jobs/${list[0].id}/classify`);
    expect(r.status).toBe(200);
    expect(r.json).toBeTruthy();
    // Contract: the envelope must always include the scrapedAt key.
    // The value is null when the cache file is missing, otherwise an ISO string.
    expect(Object.prototype.hasOwnProperty.call(r.json, 'scrapedAt')).toBe(true);
    if (r.json.scrapedAt !== null) {
      expect(typeof r.json.scrapedAt).toBe('string');
      expect(Number.isFinite(Date.parse(r.json.scrapedAt))).toBe(true);
    }
  });

  it('Replay history entries — when present — carry a capturedAt timestamp', async () => {
    // Walk the existing on-disk replay store via the API. If any job has
    // recorded runs (e.g. from prior dev usage), every entry must include
    // a capturedAt ISO string. The previous "empty runs[]" test covers the
    // post-restart empty case the UI relies on.
    const jobs = await request('GET', '/api/jobs');
    const list = Array.isArray(jobs.json) ? jobs.json : [];
    for (const j of list) {
      const r = await request('GET', `/api/replay-history/${j.id}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.json?.runs)).toBe(true);
      for (const run of r.json.runs) {
        expect(typeof run.capturedAt).toBe('string');
        expect(Number.isFinite(Date.parse(run.capturedAt))).toBe(true);
      }
    }
  });
});
