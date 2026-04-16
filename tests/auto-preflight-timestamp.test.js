/**
 * Unit tests: checkAutoPreflights() calls updateLastSuccessfulPreflightAt()
 * on every success path.
 *
 * Uses proxyquire to inject mocked CJS dependencies so that require() calls
 * inside auto-preflight.js are intercepted reliably.
 *
 * Success paths covered:
 *   1. Ping fast-path  — HTTP ping trusted + bookingAccessConfirmed + cache fresh
 *   2. Browser run     — browser preflight returns status='success'
 *   3. Browser run     — browser preflight returns status='booked'
 *   4. Failure guard   — browser preflight fails → updateLastSuccessfulPreflightAt NOT called
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const proxyquire = _require('proxyquire').noPreserveCache();

const THIRTY_MIN_MS = 30 * 60 * 1000;

const BASE_JOB = {
  id: 1,
  class_title: 'Pilates',
  class_time:  '09:00 AM',
  instructor:  null,
  day_of_week: 'Monday',
  target_date: null,
  is_active:   1,
};

function makePhase(msUntilOpen = THIRTY_MIN_MS) {
  return { phase: 'preflight', msUntilOpen, bookingOpen: new Date(Date.now() + msUntilOpen) };
}

function loadModule(overrides = {}) {
  const updateMock = vi.fn();

  const stubs = {
    '../db/jobs':                  { getAllJobs:                     () => [BASE_JOB], '@noCallThru': true },
    './booking-window':            { getPhase:                       () => makePhase(), '@noCallThru': true },
    '../bot/register-pilates':     { runBookingJob:                  vi.fn(async () => ({ status: 'success', message: 'ok' })), '@noCallThru': true },
    '../bot/dry-run-state':        { getDryRun:                      () => false, '@noCallThru': true },
    '../bot/sniper-readiness':     { loadState:                      () => ({}), updateLastSuccessfulPreflightAt: updateMock, '@noCallThru': true },
    '../bot/session-check':        { loadStatus:                     () => null, '@noCallThru': true },
    '../bot/auth-lock':            { isLocked:                       () => false, '@noCallThru': true },
    '../bot/auth-state':           { getAuthState:                   () => ({ status: 'connected', bookingAccessConfirmed: true, bookingAccessConfirmedAt: Date.now() }), updateAuthState: vi.fn(), '@noCallThru': true },
    '../bot/session-ping':         { pingSessionHttp:                async () => ({ trusted: true, detail: 'ok' }), '@noCallThru': true },
    '../classifier/scheduleCache': { isCacheAdequate:                () => true, '@noCallThru': true },
    '../bot/confirmed-ready':      { refreshConfirmedReadyState:     vi.fn(), '@noCallThru': true },
    '../bot/session-validator':    { validateSessionFastThenFallback: async () => ({ valid: true }), '@noCallThru': true },
    ...overrides,
  };

  const { checkAutoPreflights } = proxyquire('../src/scheduler/auto-preflight.js', stubs);
  return { checkAutoPreflights, updateMock, stubs };
}

describe('checkAutoPreflights — ping fast-path', () => {
  it('calls updateLastSuccessfulPreflightAt when HTTP ping succeeds with booking access confirmed and cache fresh', async () => {
    const { checkAutoPreflights, updateMock } = loadModule();

    await checkAutoPreflights({ isActive: false });

    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('does NOT call runBookingJob on the ping fast-path', async () => {
    const runBookingJob = vi.fn(async () => ({ status: 'success', message: 'ok' }));
    const { checkAutoPreflights } = loadModule({
      '../bot/register-pilates': { runBookingJob, '@noCallThru': true },
    });

    await checkAutoPreflights({ isActive: false });

    expect(runBookingJob).not.toHaveBeenCalled();
  });
});

describe('checkAutoPreflights — browser run', () => {
  it('calls updateLastSuccessfulPreflightAt when browser preflight returns success', async () => {
    const runBookingJob = vi.fn(async () => ({ status: 'success', message: 'browser ok' }));
    const { checkAutoPreflights, updateMock } = loadModule({
      '../bot/auth-state': {
        getAuthState:   () => ({ status: 'connected', bookingAccessConfirmed: false, bookingAccessConfirmedAt: null }),
        updateAuthState: vi.fn(),
        '@noCallThru': true,
      },
      '../bot/session-ping':         { pingSessionHttp: async () => ({ trusted: true, detail: 'ok' }), '@noCallThru': true },
      '../classifier/scheduleCache': { isCacheAdequate: () => false, '@noCallThru': true },
      '../bot/register-pilates':     { runBookingJob, '@noCallThru': true },
    });

    await checkAutoPreflights({ isActive: false });

    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('calls updateLastSuccessfulPreflightAt when browser preflight returns booked', async () => {
    const runBookingJob = vi.fn(async () => ({ status: 'booked', message: 'already booked' }));
    const { checkAutoPreflights, updateMock } = loadModule({
      '../bot/auth-state': {
        getAuthState:   () => ({ status: 'connected', bookingAccessConfirmed: false, bookingAccessConfirmedAt: null }),
        updateAuthState: vi.fn(),
        '@noCallThru': true,
      },
      '../bot/session-ping':         { pingSessionHttp: async () => ({ trusted: false, detail: 'miss' }), '@noCallThru': true },
      '../classifier/scheduleCache': { isCacheAdequate: () => false, '@noCallThru': true },
      '../bot/register-pilates':     { runBookingJob, '@noCallThru': true },
    });

    await checkAutoPreflights({ isActive: false });

    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('does NOT call updateLastSuccessfulPreflightAt when browser preflight fails', async () => {
    const runBookingJob = vi.fn(async () => ({ status: 'auth_failed', message: 'auth error' }));
    const { checkAutoPreflights, updateMock } = loadModule({
      '../bot/auth-state': {
        getAuthState:   () => ({ status: 'connected', bookingAccessConfirmed: false, bookingAccessConfirmedAt: null }),
        updateAuthState: vi.fn(),
        '@noCallThru': true,
      },
      '../bot/session-ping':         { pingSessionHttp: async () => ({ trusted: false, detail: 'miss' }), '@noCallThru': true },
      '../classifier/scheduleCache': { isCacheAdequate: () => false, '@noCallThru': true },
      '../bot/register-pilates':     { runBookingJob, '@noCallThru': true },
    });

    await checkAutoPreflights({ isActive: false });

    expect(updateMock).not.toHaveBeenCalled();
  });
});
