/**
 * Task #76 — durable fired-checkpoint record.
 *
 * Verifies:
 *  1. After a checkpoint fires, the cycle key is written to FIRED_FILE.
 *  2. A fresh module load (simulating a server restart) reads FIRED_FILE
 *     and refuses to fire the same checkpoint again, even when the
 *     trigger window is still open.
 *  3. Records whose bookingOpenMs is older than the 1-hour TTL are
 *     trimmed on hydration so the file does not grow unbounded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

const _require = createRequire(import.meta.url);
const proxyquire = _require('proxyquire').noPreserveCache();

const FIRED_FILE = path.resolve(__dirname, '../src/data/auto-preflight-fired.json');
const FIRED_BACKUP = FIRED_FILE + '.test-backup';

const THIRTY_MIN_MS = 30 * 60 * 1000;
const HOUR_MS       = 60 * 60 * 1000;

const BASE_JOB = {
  id: 1,
  class_title: 'Pilates',
  class_time:  '09:00 AM',
  instructor:  null,
  day_of_week: 'Monday',
  target_date: null,
  is_active:   1,
};

function makePhase(msUntilOpen = THIRTY_MIN_MS, bookingOpenMs = null) {
  const open = bookingOpenMs != null ? new Date(bookingOpenMs) : new Date(Date.now() + msUntilOpen);
  return { phase: 'preflight', msUntilOpen, bookingOpen: open };
}

function loadModule(overrides = {}, { runBookingJob, bookingOpenMs } = {}) {
  const runMock = runBookingJob || vi.fn(async () => ({ status: 'success', message: 'ok' }));
  const open = bookingOpenMs != null ? bookingOpenMs : Date.now() + THIRTY_MIN_MS;

  const stubs = {
    '../db/jobs':                  { getAllJobs:                     () => [BASE_JOB], '@noCallThru': true },
    './booking-window':            { getPhase:                       () => makePhase(open - Date.now(), open), '@noCallThru': true },
    '../bot/register-pilates':     { runBookingJob: runMock, '@noCallThru': true },
    '../bot/dry-run-state':        { getDryRun:                      () => false, '@noCallThru': true },
    '../bot/sniper-readiness':     { loadState: () => ({}), updateLastSuccessfulPreflightAt: vi.fn(), '@noCallThru': true },
    '../bot/auth-lock':            { isLocked:                       () => false, '@noCallThru': true },
    '../bot/auth-state':           {
      getAuthState:           () => ({ status: 'connected', bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now() }),
      updateAuthState:        vi.fn(),
      getCanonicalAuthTruth:  () => ({ sessionValid: true, lastCheckedAt: Date.now() }),
      '@noCallThru': true,
    },
    '../bot/session-ping':         { pingSessionHttp:                async () => ({ trusted: true, detail: 'ok' }), '@noCallThru': true },
    '../classifier/scheduleCache': { isCacheAdequate:                () => true, '@noCallThru': true },
    '../bot/confirmed-ready':      { refreshConfirmedReadyState:     vi.fn(), '@noCallThru': true },
    '../bot/session-validator':    { validateSessionFastThenFallback: async () => ({ valid: true }), '@noCallThru': true },
    ...overrides,
  };

  return { mod: proxyquire('../src/scheduler/auto-preflight.js', stubs), runMock };
}

describe('auto-preflight fired-checkpoint persistence (Task #76)', () => {
  beforeEach(() => {
    if (fs.existsSync(FIRED_FILE)) fs.renameSync(FIRED_FILE, FIRED_BACKUP);
  });

  afterEach(() => {
    if (fs.existsSync(FIRED_FILE)) fs.unlinkSync(FIRED_FILE);
    if (fs.existsSync(FIRED_BACKUP)) fs.renameSync(FIRED_BACKUP, FIRED_FILE);
  });

  it('persists fired cycleKey to disk after a successful trigger fire', async () => {
    const { mod, runMock } = loadModule();
    await mod.checkAutoPreflights({ isActive: false });

    expect(runMock).not.toHaveBeenCalled(); // ping fast path
    expect(fs.existsSync(FIRED_FILE)).toBe(true);

    const disk = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
    const keys = Object.keys(disk);
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^1:\d+:30min$/);
    expect(disk[keys[0]]).toHaveProperty('bookingOpenMs');
    expect(disk[keys[0]]).toHaveProperty('firedAt');
  });

  it('does NOT re-fire the same checkpoint after a simulated restart', async () => {
    // Pin the booking-open epoch so both "lifetimes" use the same cycleKey.
    const fixedOpen = Date.now() + THIRTY_MIN_MS;

    // First lifetime: fire the trigger.
    const first = loadModule({}, { bookingOpenMs: fixedOpen });
    await first.mod.checkAutoPreflights({ isActive: false });
    expect(fs.existsSync(FIRED_FILE)).toBe(true);

    // Second lifetime: brand-new module instance reads FIRED_FILE on hydrate
    // and must skip the same cycleKey even though the trigger window is open.
    const runMock = vi.fn(async () => ({ status: 'success', message: 'ok' }));
    const pingMock = vi.fn(async () => ({ trusted: true, detail: 'ok' }));
    const second = loadModule({
      '../bot/session-ping':     { pingSessionHttp: pingMock, '@noCallThru': true },
      '../bot/register-pilates': { runBookingJob: runMock, '@noCallThru': true },
    }, { runBookingJob: runMock, bookingOpenMs: fixedOpen });

    await second.mod.checkAutoPreflights({ isActive: false });

    // Neither ping nor browser preflight should have run — gate happens
    // before we reach either path.
    expect(pingMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('trims records older than bookingOpen + 1 hour on hydration', () => {
    const old   = Date.now() - HOUR_MS - 60 * 1000;       // expired
    const fresh = Date.now() + 5 * 60 * 1000;             // future open
    fs.writeFileSync(FIRED_FILE, JSON.stringify({
      [`1:${old}:30min`]:   { bookingOpenMs: old,   firedAt: new Date(old - 1000).toISOString() },
      [`2:${fresh}:10min`]: { bookingOpenMs: fresh, firedAt: new Date().toISOString() },
    }));

    // Trigger hydration via getNextTrigger (read-only path).
    const { mod } = loadModule({
      '../db/jobs': { getAllJobs: () => [], '@noCallThru': true },
    });
    mod.getNextTrigger();

    const after = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
    const keys = Object.keys(after);
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(`2:${fresh}:10min`);
  });

  it('survives a malformed FIRED_FILE without throwing and treats it as empty', () => {
    fs.writeFileSync(FIRED_FILE, '{not valid json');
    const { mod } = loadModule({
      '../db/jobs': { getAllJobs: () => [], '@noCallThru': true },
    });
    expect(() => mod.getNextTrigger()).not.toThrow();
  });
});
