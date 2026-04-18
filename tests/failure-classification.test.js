// Tests for the transient-vs-actionable failure taxonomy and the
// per-job aggregation that powers the Tools "At risk / Healthy" badge.

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import path from 'path';
import fs   from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use an isolated SQLite file so we don't perturb the dev DB.
const TEST_DB = path.join(__dirname, '..', 'data', `test-failure-classification-${process.pid}.db`);
process.env.SQLITE_PATH = TEST_DB;

const { isTransient, isActionable, classifyJobReliability } =
  await import('../src/scheduler/failure-classification.js');
const { recordFailure, getFailuresByJob, clearFailures } =
  await import('../src/db/failures.js');

beforeEach(() => {
  clearFailures();
});

afterAll(() => {
  try { fs.unlinkSync(TEST_DB);     } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch (_) {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch (_) {}
});

describe('failure-classification taxonomy', () => {
  test('transient set covers documented expected-retry outcomes', () => {
    for (const r of [
      'found_not_open_yet', 'button_not_visible', 'auth_timeout',
      'schedule_not_loaded', 'booking_not_open', 'concurrent_auth',
    ]) {
      expect(isTransient(r)).toBe(true);
      expect(isActionable(r)).toBe(false);
    }
  });

  test('actionable failures (modal mismatch, click_failed, etc.) are not transient', () => {
    for (const r of [
      'modal_time_mismatch', 'modal_instructor_mismatch', 'modal_mismatch',
      'click_failed', 'registration_unclear', 'class_not_found',
      'login_failed', 'unexpected_error', 'invalid_job_params',
    ]) {
      expect(isActionable(r)).toBe(true);
      expect(isTransient(r)).toBe(false);
    }
  });

  test('null/undefined/unknown reasons default to actionable (fail-safe)', () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient('totally_new_reason_introduced_later')).toBe(false);
  });
});

describe('classifyJobReliability', () => {
  test('80 transient + 0 actionable => healthy (the bug we are fixing)', () => {
    expect(classifyJobReliability({ actionableCount: 0, lastResult: 'success' })).toBe('healthy');
    expect(classifyJobReliability({ actionableCount: 0, lastResult: 'booked'  })).toBe('healthy');
  });

  test('1 actionable failure => issue', () => {
    expect(classifyJobReliability({ actionableCount: 1, lastResult: 'success' })).toBe('issue');
    expect(classifyJobReliability({ actionableCount: 2, lastResult: 'booked'  })).toBe('issue');
  });

  test('3+ actionable failures => at_risk', () => {
    expect(classifyJobReliability({ actionableCount: 3, lastResult: 'success' })).toBe('at_risk');
    expect(classifyJobReliability({ actionableCount: 84, lastResult: 'booked' })).toBe('at_risk');
  });

  test('lastResult === error/failed => at_risk regardless of count', () => {
    expect(classifyJobReliability({ actionableCount: 0, lastResult: 'error'  })).toBe('at_risk');
    expect(classifyJobReliability({ actionableCount: 0, lastResult: 'failed' })).toBe('at_risk');
  });

  test('never run => not_run', () => {
    expect(classifyJobReliability({ actionableCount: 0, lastResult: null, hasEverRun: false })).toBe('not_run');
  });
});

describe('getFailuresByJob splits transient vs actionable', () => {
  test('80 transient retries + 0 actionable returns failure_count: 0, transient_count: 80', () => {
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 0; i < 50; i++) {
      recordFailure({ jobId: 7, phase: 'navigate', reason: 'schedule_not_loaded', message: null, classTitle: 'Gentle Yoga', screenshot: null });
    }
    for (let i = 0; i < 20; i++) {
      recordFailure({ jobId: 7, phase: 'gate', reason: 'booking_not_open', message: null, classTitle: 'Gentle Yoga', screenshot: null });
    }
    for (let i = 0; i < 10; i++) {
      recordFailure({ jobId: 7, phase: 'auth', reason: 'auth_timeout', message: null, classTitle: 'Gentle Yoga', screenshot: null });
    }
    const rows = getFailuresByJob({ sinceIso: since });
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe(7);
    expect(rows[0].failure_count).toBe(0);
    expect(rows[0].transient_count).toBe(80);
    expect(rows[0].top_reason).toBeNull();
  });

  test('1 actionable + many transient => failure_count: 1, top_reason set, transient counted separately', () => {
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 0; i < 30; i++) {
      recordFailure({ jobId: 9, phase: 'navigate', reason: 'schedule_not_loaded', message: null, classTitle: 'Flow Yoga', screenshot: null });
    }
    recordFailure({ jobId: 9, phase: 'verify', reason: 'modal_time_mismatch', message: null, classTitle: 'Flow Yoga', screenshot: null });

    const rows = getFailuresByJob({ sinceIso: since });
    expect(rows).toHaveLength(1);
    expect(rows[0].failure_count).toBe(1);
    expect(rows[0].transient_count).toBe(30);
    expect(rows[0].top_reason).toBe('modal_time_mismatch');
  });

  test('top_reason picks the highest-count actionable reason, ignoring transient', () => {
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    for (let i = 0; i < 100; i++) {
      recordFailure({ jobId: 11, phase: 'navigate', reason: 'schedule_not_loaded', message: null, classTitle: 'X', screenshot: null });
    }
    for (let i = 0; i < 5; i++) {
      recordFailure({ jobId: 11, phase: 'click', reason: 'click_fallback', message: null, classTitle: 'X', screenshot: null });
    }
    for (let i = 0; i < 3; i++) {
      recordFailure({ jobId: 11, phase: 'verify', reason: 'modal_mismatch', message: null, classTitle: 'X', screenshot: null });
    }
    const rows = getFailuresByJob({ sinceIso: since });
    expect(rows[0].failure_count).toBe(8);
    expect(rows[0].transient_count).toBe(100);
    expect(rows[0].top_reason).toBe('click_fallback');
  });
});
