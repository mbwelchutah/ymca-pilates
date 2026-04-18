// Task #70 — schedule_not_loaded backoff: pure-function unit tests.
//
// Covers:
//   - 3 consecutive `schedule_not_loaded` failures triggers the backoff window.
//   - Backoff schedule (5 → 15 → 45 min) and 120 min cap.
//   - Any other reason resets the counter.
//   - Near-open lifts the gate but preserves state for re-engagement.
//   - markLoggedOnce returns true once per backoff window.

import { describe, test, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const sb = _require('../src/scheduler/schedule-not-loaded-backoff');

const JOB = 42;

describe('schedule_not_loaded backoff', () => {
  beforeEach(() => sb.reset());

  test('first 2 failures do NOT trigger backoff', () => {
    sb.recordResult(JOB, 'schedule_not_loaded');
    sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.getBackoffStatus(JOB).inBackoff).toBe(false);
  });

  test('3rd consecutive failure triggers backoff at 5 min', () => {
    sb.recordResult(JOB, 'schedule_not_loaded');
    sb.recordResult(JOB, 'schedule_not_loaded');
    sb.recordResult(JOB, 'schedule_not_loaded');
    const st = sb.getBackoffStatus(JOB);
    expect(st.inBackoff).toBe(true);
    expect(st.consecutive).toBe(3);
    // ~5 min ± a few ms
    expect(st.retryInMs).toBeGreaterThan(4 * 60_000);
    expect(st.retryInMs).toBeLessThanOrEqual(5 * 60_000);
  });

  test('backoff schedule grows: 5 → 15 → 45 min, then caps at 120 min', () => {
    for (let i = 0; i < 3; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeLessThanOrEqual(5 * 60_000);

    sb.recordResult(JOB, 'schedule_not_loaded'); // 4th
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeGreaterThan(14 * 60_000);
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeLessThanOrEqual(15 * 60_000);

    sb.recordResult(JOB, 'schedule_not_loaded'); // 5th
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeGreaterThan(44 * 60_000);
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeLessThanOrEqual(45 * 60_000);

    sb.recordResult(JOB, 'schedule_not_loaded'); // 6th — beyond schedule, cap
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeGreaterThan(119 * 60_000);
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeLessThanOrEqual(120 * 60_000);

    sb.recordResult(JOB, 'schedule_not_loaded'); // 7th — still capped
    expect(sb.getBackoffStatus(JOB).retryInMs).toBeLessThanOrEqual(120 * 60_000);
  });

  test('non-trigger reason resets the counter and clears backoff', () => {
    for (let i = 0; i < 4; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.getBackoffStatus(JOB).inBackoff).toBe(true);

    sb.recordResult(JOB, null); // success-like
    expect(sb.getBackoffStatus(JOB).inBackoff).toBe(false);
    expect(sb.getBackoffStatus(JOB).consecutive).toBe(0);

    // And a different failure reason also resets:
    for (let i = 0; i < 3; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.getBackoffStatus(JOB).inBackoff).toBe(true);
    sb.recordResult(JOB, 'modal_time_mismatch');
    expect(sb.getBackoffStatus(JOB).inBackoff).toBe(false);
    expect(sb.getBackoffStatus(JOB).consecutive).toBe(0);
  });

  test('near-open window LIFTS the gate but preserves the consecutive counter', () => {
    for (let i = 0; i < 3; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.getBackoffStatus(JOB, /*msToOpen=*/ 30 * 60_000).inBackoff).toBe(true);

    // Within 10 min of open — gate is lifted so the manual/scheduler attempt fires.
    const lifted = sb.getBackoffStatus(JOB, /*msToOpen=*/ 5 * 60_000);
    expect(lifted.inBackoff).toBe(false);
    expect(lifted.nearOpenLifted).toBe(true);
    expect(lifted.consecutive).toBe(3); // counter preserved

    // Once we move back outside the near-open window, the gate is back on
    // (until the wall-clock backoff timestamp passes).
    expect(sb.getBackoffStatus(JOB, /*msToOpen=*/ 30 * 60_000).inBackoff).toBe(true);
  });

  test('markLoggedOnce returns true once per backoff window, then false', () => {
    for (let i = 0; i < 3; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.markLoggedOnce(JOB)).toBe(true);
    expect(sb.markLoggedOnce(JOB)).toBe(false);
    expect(sb.markLoggedOnce(JOB)).toBe(false);

    // A new failure extends the window — and resets the per-window log gate.
    sb.recordResult(JOB, 'schedule_not_loaded');
    expect(sb.markLoggedOnce(JOB)).toBe(true);
    expect(sb.markLoggedOnce(JOB)).toBe(false);
  });

  test('snapshotForApi returns null when no state exists', () => {
    expect(sb.snapshotForApi(JOB)).toBeNull();
  });

  test('snapshotForApi returns the active backoff state', () => {
    for (let i = 0; i < 3; i++) sb.recordResult(JOB, 'schedule_not_loaded');
    const snap = sb.snapshotForApi(JOB);
    expect(snap).not.toBeNull();
    expect(snap.inBackoff).toBe(true);
    expect(snap.consecutive).toBe(3);
  });

  test('reset(jobId) clears state for that job only', () => {
    for (let i = 0; i < 3; i++) sb.recordResult(1, 'schedule_not_loaded');
    for (let i = 0; i < 3; i++) sb.recordResult(2, 'schedule_not_loaded');
    sb.reset(1);
    expect(sb.getBackoffStatus(1).inBackoff).toBe(false);
    expect(sb.getBackoffStatus(2).inBackoff).toBe(true);
  });
});
