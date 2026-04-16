/**
 * Integration test: GET /api/failures returns the correct `hideBefore` value.
 *
 * Starts the real server on a dedicated test port, writes a known
 * lastSuccessfulPreflightAt to sniper-state.json, then asserts that
 * hideBefore in the JSON response matches exactly.
 *
 * Server.js line 5316:
 *   hideBefore = sniperState?.lastSuccessfulPreflightAt ?? null;
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn }                                      from 'child_process';
import http                                           from 'http';
import fs                                             from 'fs';
import path                                           from 'path';
import { fileURLToPath }                              from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE  = path.resolve(__dirname, '../src/data/sniper-state.json');
const BACKUP_FILE = STATE_FILE + '.hidebefore-test-bak';
const TEST_PORT   = 5099;

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('request timed out')); });
  });
}

function waitForServer(port, retries = 20, delayMs = 300) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      const req = http.get(`http://localhost:${port}/api/failures`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++attempts >= retries) { reject(new Error(`Server did not start on port ${port}`)); return; }
        setTimeout(attempt, delayMs);
      });
      req.setTimeout(500, () => { req.destroy(); });
    }
    attempt();
  });
}

let serverProcess;

beforeAll(async () => {
  if (fs.existsSync(STATE_FILE)) fs.renameSync(STATE_FILE, BACKUP_FILE);

  serverProcess = spawn(process.execPath, ['src/web/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'ignore',
  });

  await waitForServer(TEST_PORT);
}, 30_000);

afterAll(() => {
  if (serverProcess) serverProcess.kill('SIGTERM');
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(BACKUP_FILE)) fs.renameSync(BACKUP_FILE, STATE_FILE);
});

describe('GET /api/failures — hideBefore field', () => {
  it('returns hideBefore=null when no lastSuccessfulPreflightAt has been recorded', async () => {
    const data = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    expect(data).toHaveProperty('hideBefore');
    expect(data.hideBefore).toBeNull();
  });

  it('returns hideBefore matching lastSuccessfulPreflightAt after a preflight success write', async () => {
    const ts = new Date().toISOString();
    const dataDir = path.dirname(STATE_FILE);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSuccessfulPreflightAt: ts }));

    const data = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    expect(data.hideBefore).toBe(ts);
  });

  it('returns hideBefore=null when state file has no lastSuccessfulPreflightAt field', async () => {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    const dataDir = path.dirname(STATE_FILE);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ runId: 'abc', phase: 'AUTH' }));

    const data = await getJson(`http://localhost:${TEST_PORT}/api/failures`);
    expect(data.hideBefore).toBeNull();
  });
});
