/**
 * Auto-checks orchestrator — STAGE 6.
 *
 * Background, fire-and-forget glue between:
 *
 *   src/health/cadence-policy.js  (pure: should we run?)
 *   src/health/cheap-check.js     (HTTP ping)
 *   src/health/deep-check.js      (preflight wrapper)
 *
 * Called once per scheduler-loop iteration AFTER `runTick()` has returned.
 * The booking pipeline is therefore guaranteed to have already finished
 * its synchronous work for this tick before any check is even decided.
 *
 * Strict invariants for this stage:
 *
 *   - Booking, sniper, retry, selector, classifier code is NEVER touched.
 *   - This module makes NO booking decisions.  It only reads job rows
 *     to pick a cadence driver (the soonest active job).
 *   - Cheap and deep launches are FIRE-AND-FORGET.  The promise returned
 *     by runAutoChecksTick() resolves as soon as the decision and launch
 *     happen — never awaits the actual ping or browser flow.
 *   - Process-wide single-flight guards keep two scheduler ticks 60 s
 *     apart from launching duplicate concurrent checks.
 *   - Below T-30m we do NOT trigger deep checks; the existing
 *     T-30/T-10/T-2 checkpoints in src/scheduler/auto-preflight.js
 *     own that window and we explicitly defer to them
 *     (cadence-policy.shouldRunDeepCheck returns false).
 */

'use strict';

const { getAllJobs }                           = require('../db/jobs');
const { getPhase, isPastClass }                = require('./_booking-window-shim');
const { loadHealth }                           = require('./connection-health-store');
const {
  shouldRunCheapCheck,
  shouldRunDeepCheck,
}                                               = require('./cadence-policy');
const { runCheapCheck }                        = require('./cheap-check');
const { runDeepPreflightCheck }                = require('./deep-check');

// Process-wide single-flight guards.  Distinct promise per check kind so a
// long-running deep check never blocks a fast cheap ping.
let _cheapInFlight = null;
let _deepInFlight  = null;

// ─── Cadence driver: soonest upcoming active job ────────────────────────────

/**
 * Pick the active, future, non-past job with the smallest msUntilOpen.
 * Returns { job, msUntilOpen } or null when no upcoming job exists.
 *
 * msUntilOpen can be negative (window already open).  We treat negative
 * values as "0 ms until open" so cadence policy uses the tightest interval.
 *
 * Pure read against the jobs table; no writes.
 */
function pickCadenceDriver() {
  let jobs;
  try { jobs = getAllJobs().filter(j => j.is_active === 1); }
  catch { return null; }

  let best       = null;
  let bestMsOpen = Infinity;

  for (const dbJob of jobs) {
    const job = {
      id:          dbJob.id,
      classTitle:  dbJob.class_title,
      classTime:   dbJob.class_time,
      instructor:  dbJob.instructor || null,
      dayOfWeek:   dbJob.day_of_week,
      targetDate:  dbJob.target_date || null,
    };
    if (isPastClass(dbJob)) continue;

    let phaseInfo;
    try { phaseInfo = getPhase(job); } catch { continue; }
    const ms = Number.isFinite(phaseInfo.msUntilOpen) ? phaseInfo.msUntilOpen : null;
    if (ms == null) continue;

    // Treat already-open windows as ms=0 so policy uses tightest interval.
    const effectiveMs = Math.max(ms, 0);
    if (effectiveMs < bestMsOpen) {
      best       = { job, dbJob, msUntilOpen: ms };
      bestMsOpen = effectiveMs;
    }
  }

  return best;
}

// ─── Public: one orchestration pass ─────────────────────────────────────────

/**
 * Decide which (if any) auto-checks are due and launch them in the
 * background.  Always resolves quickly; the actual ping / browser work
 * runs detached on a separate microtask.
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.now=Date.now()]
 * @returns {Promise<{
 *   driverJobId:  ?number,
 *   msUntilOpen:  ?number,
 *   cheap: { decided: 'launched'|'skipped_cadence'|'skipped_inflight'|'skipped_no_driver' },
 *   deep:  { decided: 'launched'|'skipped_cadence'|'skipped_inflight'|'skipped_no_driver'|'skipped_window' },
 * }>}
 */
async function runAutoChecksTick({ now = Date.now() } = {}) {
  const driver = pickCadenceDriver();
  const health = loadHealth();

  // No upcoming job → use null msUntilOpen (cadence policy treats as FAR).
  // We still run cheap checks (so the connection-health record stays warm),
  // but we skip the deep path because there is no specific job to verify.
  const msUntilOpen = driver ? driver.msUntilOpen : null;

  // ── Cheap path ────────────────────────────────────────────────────────────
  let cheapDecision;
  if (_cheapInFlight) {
    cheapDecision = 'skipped_inflight';
  } else if (!shouldRunCheapCheck(now, health, msUntilOpen)) {
    cheapDecision = 'skipped_cadence';
  } else {
    cheapDecision = 'launched';
    _cheapInFlight = (async () => {
      try { await runCheapCheck({ msUntilOpen }); }
      catch (e) { console.warn(`[health/auto-checks] cheap check threw: ${e && e.message}`); }
      finally   { _cheapInFlight = null; }
    })();
    // FIRE-AND-FORGET: do NOT await — let the scheduler tick return.
  }

  // ── Deep path ─────────────────────────────────────────────────────────────
  let deepDecision;
  if (!driver) {
    deepDecision = 'skipped_no_driver';
  } else if (_deepInFlight) {
    deepDecision = 'skipped_inflight';
  } else if (!shouldRunDeepCheck(now, health, msUntilOpen)) {
    // Either inside <30m existing-checkpoint window OR cadence not yet due.
    deepDecision = msUntilOpen != null && msUntilOpen < 30 * 60 * 1000
      ? 'skipped_window'
      : 'skipped_cadence';
  } else {
    deepDecision = 'launched';
    const jobId = driver.job.id;
    _deepInFlight = (async () => {
      try { await runDeepPreflightCheck(jobId, { msUntilOpen }); }
      catch (e) { console.warn(`[health/auto-checks] deep check threw: ${e && e.message}`); }
      finally   { _deepInFlight = null; }
    })();
    // FIRE-AND-FORGET.
  }

  return {
    driverJobId: driver ? driver.job.id : null,
    msUntilOpen,
    cheap: { decided: cheapDecision },
    deep:  { decided: deepDecision  },
  };
}

// Test helper — lets test suites observe in-flight state without exporting
// the raw promises.
function _isAnyInFlight() {
  return Boolean(_cheapInFlight || _deepInFlight);
}

module.exports = {
  runAutoChecksTick,
  pickCadenceDriver,
  _isAnyInFlight,
};
