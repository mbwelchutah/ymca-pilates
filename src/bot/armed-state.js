// Sniper armed state engine (Stage 9D)
//
// Computes a discrete armed state from the normalized readiness object
// (Stage 9B) plus job/scheduler context.  This is distinct from the
// confidence score (Stage 9C), which is a gradient — armed answers the
// binary question "is the system watching and prepared to act?"
//
// Purely computational: reads nothing from disk, writes nothing.
// All inputs must be provided by the caller.  Stage 9E calls this fresh
// on every API request so nextWindow is always current.
//
// Return shape:
// {
//   armed         : boolean  — true only when state === 'armed'
//   state         : "waiting" | "almost_ready" | "armed" |
//                   "booking" | "needs_attention"
//   nextWindow    : ISO string | null   — when the booking window opens
//   autoRetry     : boolean  — scheduler is active and will retry
//   watchingActive: boolean  — scheduler is running (not paused)
// }
//
// State machine (evaluated in priority order):
//   1. bookingActive=true                                    → 'booking'
//   2. session/schedule error OR discovery missing OR modal blocked
//                                                            → 'needs_attention'
//   3. session=ready AND discovery=found AND modal=reachable → 'armed'
//   4. session=ready AND discovery=found AND modal=unknown   → 'almost_ready'
//   5. session=ready AND discovery=unknown                   → 'waiting'
//   6. (catch-all)                                           → 'needs_attention'

'use strict';

const { getPhase } = require('../scheduler/booking-window');

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object}  opts.readiness      Normalized readiness object from readiness-state.js
 * @param {object|null} opts.job        DB job row (needs classTime/class_time, dayOfWeek/day_of_week, etc.)
 * @param {boolean} opts.bookingActive  True while a real booking run is in progress
 * @param {boolean} opts.schedulerPaused True if the scheduler has been manually paused
 * @returns {{ armed, state, nextWindow, autoRetry, watchingActive }}
 */
function computeArmedState({
  readiness      = {},
  job            = null,
  bookingActive  = false,
  schedulerPaused = false,
} = {}) {
  const {
    session   = 'unknown',
    schedule  = 'unknown',
    discovery = 'unknown',
    modal     = 'unknown',
  } = readiness;

  // ── nextWindow ─────────────────────────────────────────────────────────────
  // Compute fresh from booking-window so it is never stale.
  let nextWindow = null;
  if (job) {
    try {
      const { bookingOpen } = getPhase(job);
      nextWindow = bookingOpen.toISOString();
    } catch (_) {
      // Non-fatal — job shape may be incomplete at call time.
    }
  }

  // ── Derived flags ──────────────────────────────────────────────────────────
  const watchingActive = !schedulerPaused;
  const autoRetry      = watchingActive && job?.is_active === 1;

  // ── State machine ──────────────────────────────────────────────────────────
  let state;

  if (bookingActive) {
    // A real booking run is in progress — highest priority.
    state = 'booking';
  } else if (
    session   === 'error'   ||
    schedule  === 'error'   ||
    discovery === 'missing' ||
    modal     === 'blocked'
  ) {
    // At least one signal is explicitly broken.
    state = 'needs_attention';
  } else if (session === 'ready' && discovery === 'found' && modal === 'reachable') {
    // All three required conditions confirmed: session, class, and modal.
    state = 'armed';
  } else if (session === 'ready' && discovery === 'found' && modal === 'unknown') {
    // Class confirmed, modal not yet checked — almost there.
    state = 'almost_ready';
  } else if (session === 'ready' && discovery === 'unknown') {
    // Session confirmed but class not yet verified — waiting for preflight.
    state = 'waiting';
  } else {
    // Unknown/unclassifiable combination.
    state = 'needs_attention';
  }

  const armed = state === 'armed';

  return { armed, state, nextWindow, autoRetry, watchingActive };
}

module.exports = { computeArmedState };
