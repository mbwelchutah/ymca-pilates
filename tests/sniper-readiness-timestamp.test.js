/**
 * Unit tests for updateLastSuccessfulPreflightAt() in sniper-readiness.js
 *
 * Tests that the helper correctly reads/writes lastSuccessfulPreflightAt
 * to the state file, covering:
 *   - first run (no prior state file)
 *   - successive runs (timestamp advances)
 *   - pre-existing state is preserved (other fields not clobbered)
 *
 * Also covers the /api/failures hideBefore contract:
 *   - hideBefore is null when no state exists
 *   - hideBefore equals lastSuccessfulPreflightAt when state exists
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const STATE_FILE  = path.resolve(__dirname, '../src/data/sniper-state.json');
const BACKUP_FILE = STATE_FILE + '.test-bak';
const DATA_DIR    = path.dirname(STATE_FILE);

function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

beforeEach(() => {
  if (fs.existsSync(STATE_FILE)) fs.renameSync(STATE_FILE, BACKUP_FILE);
});

afterEach(() => {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(BACKUP_FILE)) fs.renameSync(BACKUP_FILE, STATE_FILE);
});

describe('updateLastSuccessfulPreflightAt()', () => {
  it('sets lastSuccessfulPreflightAt on first run (no prior state file)', () => {
    const { updateLastSuccessfulPreflightAt } = require('../src/bot/sniper-readiness.js');

    expect(fs.existsSync(STATE_FILE)).toBe(false);

    const before = new Date().toISOString();
    updateLastSuccessfulPreflightAt();
    const after = new Date().toISOString();

    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const state = readState();
    expect(state.lastSuccessfulPreflightAt).toBeDefined();
    expect(state.lastSuccessfulPreflightAt >= before).toBe(true);
    expect(state.lastSuccessfulPreflightAt <= after).toBe(true);
  });

  it('advances lastSuccessfulPreflightAt on successive calls', async () => {
    const { updateLastSuccessfulPreflightAt } = require('../src/bot/sniper-readiness.js');

    updateLastSuccessfulPreflightAt();
    const firstTs = readState().lastSuccessfulPreflightAt;

    await sleep(5);

    updateLastSuccessfulPreflightAt();
    const secondTs = readState().lastSuccessfulPreflightAt;

    expect(new Date(secondTs).getTime()).toBeGreaterThanOrEqual(new Date(firstTs).getTime());
  });

  it('preserves pre-existing state fields when updating the timestamp', () => {
    const existing = {
      runId:       'existing-run-id',
      phase:       'AUTH',
      sniperState: 'SNIPER_READY',
      events:      [{ phase: 'AUTH', message: 'ok' }],
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(existing));

    const { updateLastSuccessfulPreflightAt } = require('../src/bot/sniper-readiness.js');
    updateLastSuccessfulPreflightAt();

    const state = readState();
    expect(state.runId).toBe('existing-run-id');
    expect(state.phase).toBe('AUTH');
    expect(state.sniperState).toBe('SNIPER_READY');
    expect(state.events).toHaveLength(1);
    expect(state.lastSuccessfulPreflightAt).toBeDefined();
  });
});

describe('/api/failures hideBefore contract', () => {
  it('returns null when no state file exists', () => {
    const { loadState } = require('../src/bot/sniper-readiness.js');

    expect(fs.existsSync(STATE_FILE)).toBe(false);
    const sniperState = loadState();
    const hideBefore = sniperState?.lastSuccessfulPreflightAt ?? null;

    expect(hideBefore).toBeNull();
  });

  it('returns lastSuccessfulPreflightAt from state file', () => {
    const ts = '2025-01-15T10:00:00.000Z';
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSuccessfulPreflightAt: ts }));

    const { loadState } = require('../src/bot/sniper-readiness.js');
    const sniperState = loadState();
    const hideBefore = sniperState?.lastSuccessfulPreflightAt ?? null;

    expect(hideBefore).toBe(ts);
  });

  it('hideBefore advances after updateLastSuccessfulPreflightAt is called', () => {
    const { updateLastSuccessfulPreflightAt, loadState } = require('../src/bot/sniper-readiness.js');

    const before = new Date().toISOString();
    updateLastSuccessfulPreflightAt();

    const sniperState = loadState();
    const hideBefore = sniperState?.lastSuccessfulPreflightAt ?? null;

    expect(hideBefore).not.toBeNull();
    expect(hideBefore >= before).toBe(true);
  });

  it('hideBefore is null when state exists but lastSuccessfulPreflightAt was never set', () => {
    const stateWithoutTimestamp = { runId: 'abc', phase: 'AUTH' };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateWithoutTimestamp));

    const { loadState } = require('../src/bot/sniper-readiness.js');
    const sniperState = loadState();
    const hideBefore = sniperState?.lastSuccessfulPreflightAt ?? null;

    expect(hideBefore).toBeNull();
  });
});
