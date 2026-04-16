/**
 * Unit tests: runPreflightLoop() calls updateLastSuccessfulPreflightAt()
 * on every success path.
 *
 * Uses proxyquire to inject mocked CJS dependencies so that require() calls
 * inside preflight-loop.js are intercepted reliably.
 *
 * Success paths covered:
 *   1. Main loop   — job 2 h away, runBookingJob→success, classifyFailure→null
 *   2. Burst check — job in warmup phase, burst runBookingJob→success, classifyFailure→null
 *   3. Failure guard — main loop runBookingJob fails → NOT called
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const proxyquire = _require('proxyquire').noPreserveCache();

const TWO_HOURS_MS  = 2  * 60 * 60 * 1000;
const NINETY_SEC_MS = 90 * 1000;
const WARMUP_OFFSET_MS = 3 * 60 * 1000;
const ARMED_OFFSET_MS  = 45 * 1000;

let jobCounter = 300;

function makeJob(overrides = {}) {
  return {
    id:          jobCounter++,
    class_title: 'Yoga',
    class_time:  '10:00 AM',
    instructor:  null,
    day_of_week: 'Tuesday',
    target_date: null,
    is_active:   1,
    ...overrides,
  };
}

function loadModule(overrides = {}) {
  const updateMock = vi.fn();

  const stubs = {
    '../db/jobs':                    { getAllJobs:             vi.fn(() => []), '@noCallThru': true },
    './booking-window':              { getPhase:              vi.fn(() => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, bookingOpen: new Date(Date.now() + TWO_HOURS_MS) })), '@noCallThru': true },
    '../bot/register-pilates':       { runBookingJob:         vi.fn(async () => ({ status: 'success', message: 'ok' })), '@noCallThru': true },
    '../bot/dry-run-state':          { getDryRun:             () => false, '@noCallThru': true },
    '../bot/sniper-readiness':       { loadState:             () => ({ sniperState: 'SNIPER_READY' }), updateLastSuccessfulPreflightAt: updateMock, '@noCallThru': true },
    '../bot/auth-lock':              { isLocked:              () => false, '@noCallThru': true },
    '../bot/auth-state':             { getAuthState:          () => ({ status: 'connected' }), getCanonicalAuthTruth: () => ({ sessionValid: true, lastCheckedAt: Date.now() }), '@noCallThru': true },
    '../bot/readiness-state':        { refreshReadiness:      vi.fn(), '@noCallThru': true },
    './execution-timing':            { computeExecutionTiming: vi.fn(() => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, opensAt: new Date(Date.now() + TWO_HOURS_MS).toISOString() })), WARMUP_OFFSET_MS, ARMED_OFFSET_MS, '@noCallThru': true },
    './retry-strategy':              { classifyFailure:       vi.fn(() => null), computeRetry: vi.fn(() => ({ shouldRetry: false, retryDelayMs: 180_000, note: 'ok' })), '@noCallThru': true },
    './escalation':                  { setEscalation:         vi.fn(), clearEscalation: vi.fn(), '@noCallThru': true },
    './timing-learner':              { recordObservation:     vi.fn(), getLearnedOffsets: vi.fn(() => null), recordRunSpeed: vi.fn(), getLearnedRunSpeed: vi.fn(() => null), '@noCallThru': true },
    './booking-bridge':              { triggerBookingFromBurst: vi.fn(async () => {}), '@noCallThru': true },
    '../bot/confirmed-ready':        { refreshConfirmedReadyState: vi.fn(), '@noCallThru': true },
    ...overrides,
  };

  const { runPreflightLoop } = proxyquire('../src/scheduler/preflight-loop.js', stubs);
  return { runPreflightLoop, updateMock, stubs };
}

describe('runPreflightLoop — main loop success', () => {
  it('calls updateLastSuccessfulPreflightAt when main-loop preflight succeeds', async () => {
    const job = makeJob();
    const { runPreflightLoop, updateMock } = loadModule({
      '../db/jobs':         { getAllJobs: () => [job], '@noCallThru': true },
      './booking-window':   { getPhase: () => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, bookingOpen: new Date(Date.now() + TWO_HOURS_MS) }), '@noCallThru': true },
      './execution-timing': { computeExecutionTiming: () => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, opensAt: new Date(Date.now() + TWO_HOURS_MS).toISOString() }), WARMUP_OFFSET_MS, ARMED_OFFSET_MS, '@noCallThru': true },
      '../bot/register-pilates': { runBookingJob: async () => ({ status: 'success', message: 'all clear' }), '@noCallThru': true },
      './retry-strategy':   { classifyFailure: () => null, computeRetry: () => ({ shouldRetry: false, retryDelayMs: 180_000, note: 'ok' }), '@noCallThru': true },
    });

    await runPreflightLoop({ isActive: false });

    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('does NOT call updateLastSuccessfulPreflightAt when main-loop preflight fails', async () => {
    const job = makeJob();
    const { runPreflightLoop, updateMock } = loadModule({
      '../db/jobs':         { getAllJobs: () => [job], '@noCallThru': true },
      './booking-window':   { getPhase: () => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, bookingOpen: new Date(Date.now() + TWO_HOURS_MS) }), '@noCallThru': true },
      './execution-timing': { computeExecutionTiming: () => ({ phase: 'too_early', msUntilOpen: TWO_HOURS_MS, opensAt: new Date(Date.now() + TWO_HOURS_MS).toISOString() }), WARMUP_OFFSET_MS, ARMED_OFFSET_MS, '@noCallThru': true },
      '../bot/register-pilates': { runBookingJob: async () => ({ status: 'auth_failed', message: 'auth error' }), '@noCallThru': true },
      './retry-strategy':   { classifyFailure: () => 'auth_failed', computeRetry: () => ({ shouldRetry: true, retryDelayMs: 60_000, note: 'retry' }), '@noCallThru': true },
    });

    await runPreflightLoop({ isActive: false });

    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('runPreflightLoop — burst success (runBurstCheck)', () => {
  it('calls updateLastSuccessfulPreflightAt when burst check finds action available', async () => {
    const job = makeJob();
    const opensAt = new Date(Date.now() + NINETY_SEC_MS).toISOString();

    const { runPreflightLoop, updateMock } = loadModule({
      '../db/jobs': { getAllJobs: () => [job], '@noCallThru': true },
      './booking-window': {
        getPhase: () => ({
          phase: 'too_early',
          msUntilOpen: 48 * 60 * 60 * 1000,
          bookingOpen: new Date(Date.now() + 48 * 60 * 60 * 1000),
        }),
        '@noCallThru': true,
      },
      './execution-timing': {
        computeExecutionTiming: () => ({ phase: 'warmup', msUntilOpen: NINETY_SEC_MS, opensAt }),
        WARMUP_OFFSET_MS,
        ARMED_OFFSET_MS,
        '@noCallThru': true,
      },
      '../bot/register-pilates': { runBookingJob: async () => ({ status: 'success', message: 'action ready' }), '@noCallThru': true },
      './retry-strategy':        { classifyFailure: () => null, computeRetry: () => ({ shouldRetry: false, retryDelayMs: 180_000, note: 'ok' }), '@noCallThru': true },
    });

    await runPreflightLoop({ isActive: false });
    await new Promise(r => setImmediate(r));

    expect(updateMock).toHaveBeenCalledOnce();
  });
});
