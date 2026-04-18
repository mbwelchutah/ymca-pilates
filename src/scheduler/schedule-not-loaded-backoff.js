// Per-job backoff for repeated `schedule_not_loaded` failures (Task #70).
//
// Why this exists:
//   When the YMCA schedule iframe fails to render after the centralized
//   readiness wait + reload retry (see register-pilates.js Task #62 path),
//   the run bails with reason='schedule_not_loaded'.  The scheduler then
//   retries on its normal cadence (~2 min in warmup) — but the underlying
//   condition (Daxko-side schedule glitch, network throttle, etc.) usually
//   persists for tens of minutes.  Hammering it just burns Daxko sessions
//   and floods the failure log (Flow Yoga: 180 entries / 7 days observed).
//
// Policy:
//   - After THRESHOLD consecutive `schedule_not_loaded` results on the same
//     job, the scheduler skips that job for an exponentially-growing window
//     (5 min → 15 min → 45 min → cap at 120 min).
//   - Any NON-`schedule_not_loaded` result (success, other failure, etc.)
//     resets the counter and clears the gate.
//   - When the booking-open moment is within NEAR_OPEN_MS (or has already
//     passed — `late` phase), the gate is fully RESET (state is cleared) so
//     we try hard during the window the user is actually waiting on.  If
//     `schedule_not_loaded` then recurs, the counter rebuilds from zero.
//   - Manual "Run check" (preflight) bypasses the gate by calling
//     runBookingJob directly — it doesn't go through the tick gate.
//
// State is in-memory only (per-process).  This is fine because:
//   - The scheduler is a single-process Node app.
//   - On restart, the gate naturally clears and we re-attempt; if the
//     condition still exists, we'll re-engage after THRESHOLD more failures.

const TRIGGER_REASON       = 'schedule_not_loaded';
const THRESHOLD            = 3;
const BACKOFF_SCHEDULE_MS  = [5, 15, 45].map(m => m * 60_000);
const MAX_BACKOFF_MS       = 120 * 60_000;
const NEAR_OPEN_MS         = 10 * 60_000;

// jobId -> { consecutive, backoffUntilMs, lastLoggedAt }
const _state = new Map();

function _ensure(jobId) {
  let s = _state.get(jobId);
  if (!s) {
    s = { consecutive: 0, backoffUntilMs: 0, lastLoggedAt: 0 };
    _state.set(jobId, s);
  }
  return s;
}

function _backoffFor(consecutiveOverThreshold) {
  if (consecutiveOverThreshold < BACKOFF_SCHEDULE_MS.length) {
    return BACKOFF_SCHEDULE_MS[consecutiveOverThreshold];
  }
  return MAX_BACKOFF_MS;
}

/**
 * Record the outcome of a booking attempt for backoff purposes.
 *
 * @param {number|null} jobId
 * @param {string|null} reason  the structured failure reason (e.g.
 *   'schedule_not_loaded') or null/'' for success / unrelated outcomes
 */
function recordResult(jobId, reason) {
  if (jobId == null) return;
  const s = _ensure(jobId);
  if (reason === TRIGGER_REASON) {
    s.consecutive += 1;
    if (s.consecutive >= THRESHOLD) {
      const idx = s.consecutive - THRESHOLD;
      const dur = _backoffFor(idx);
      s.backoffUntilMs = Date.now() + dur;
      s.lastLoggedAt   = 0; // new window — allow one log
    }
    return;
  }
  // Non-trigger result — reset everything for this job.
  if (s.consecutive > 0 || s.backoffUntilMs > 0) {
    _state.delete(jobId);
  }
}

/**
 * Compute the current gate decision for a job.
 *
 * @param {number} jobId
 * @param {number|null} msToOpen  ms until the booking window opens; null when
 *   unknown.  Used to LIFT the gate inside the near-open window.
 * @returns {{
 *   inBackoff:       boolean,
 *   consecutive:     number,
 *   backoffUntilMs:  number,
 *   retryInMs:       number,
 *   nearOpenReset?: boolean,
 * }}
 */
function getBackoffStatus(jobId, msToOpen = null) {
  const s = _state.get(jobId);
  if (!s) {
    return { inBackoff: false, consecutive: 0, backoffUntilMs: 0, retryInMs: 0 };
  }
  // Near-open RESET: if booking is within NEAR_OPEN_MS or already past
  // (msToOpen <= NEAR_OPEN_MS, including negative values for the `late`
  // phase), wipe the gate entirely so we try hard during the window the user
  // actually cares about.  If `schedule_not_loaded` recurs, the counter will
  // rebuild from zero.
  if (msToOpen != null && msToOpen <= NEAR_OPEN_MS) {
    _state.delete(jobId);
    return {
      inBackoff:      false,
      consecutive:    0,
      backoffUntilMs: 0,
      retryInMs:      0,
      nearOpenReset:  true,
    };
  }
  const now = Date.now();
  if (s.backoffUntilMs <= now) {
    return { inBackoff: false, consecutive: s.consecutive, backoffUntilMs: 0, retryInMs: 0 };
  }
  return {
    inBackoff:      true,
    consecutive:    s.consecutive,
    backoffUntilMs: s.backoffUntilMs,
    retryInMs:      s.backoffUntilMs - now,
  };
}

/**
 * Returns true exactly once per backoff window so the scheduler can log
 * "still in backoff" without flooding the console on every tick.
 */
function markLoggedOnce(jobId) {
  const s = _state.get(jobId);
  if (!s) return false;
  if (s.lastLoggedAt === 0) {
    s.lastLoggedAt = Date.now();
    return true;
  }
  return false;
}

/** Manual reset — used by tests and any future "clear backoff" UI action. */
function reset(jobId) {
  if (jobId == null) _state.clear();
  else _state.delete(jobId);
}

/** Snapshot for diagnostics / API exposure.  Returns null when no state. */
function snapshotForApi(jobId, msToOpen = null) {
  if (!_state.has(jobId)) return null;
  const st = getBackoffStatus(jobId, msToOpen);
  if (!st.inBackoff && st.consecutive === 0) return null;
  return st;
}

module.exports = {
  TRIGGER_REASON,
  THRESHOLD,
  BACKOFF_SCHEDULE_MS,
  MAX_BACKOFF_MS,
  NEAR_OPEN_MS,
  recordResult,
  getBackoffStatus,
  markLoggedOnce,
  reset,
  snapshotForApi,
};
