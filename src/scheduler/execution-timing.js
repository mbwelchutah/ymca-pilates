// Execution timing model (Stage 10A)
//
// Provides a finer-grained phase model for the execution window, sitting on
// top of the coarser booking-window.js scheduler phases (too_early / warmup /
// sniper / late).  Where booking-window.js answers "should the scheduler act?",
// this module answers "exactly how close are we, and what execution phase are
// we in?".
//
// Offsets (conservative defaults — Stage 10F may learn small adjustments):
//   warmupAt = opensAt − WARMUP_OFFSET_MS  (3 min)  browser warm-up begins
//   armedAt  = opensAt − ARMED_OFFSET_MS   (45 sec) ready-to-fire posture
//
// Phase transition (evaluated in order):
//   now < warmupAt                   → "waiting"    — window is distant, just watch
//   warmupAt ≤ now < armedAt         → "warmup"     — browser should be warming up
//   armedAt  ≤ now < opensAt         → "armed"      — imminent; fire at open
//   now ≥ opensAt, isConfirming=true → "confirming" — click sent, awaiting result
//   now ≥ opensAt                    → "executing"  — window open, actively trying
//
// The "confirming" and "executing" phases cannot be computed from time alone
// and require the caller to supply runtime context (isBookingActive, isConfirming).
//
// Shape returned by computeExecutionTiming():
// {
//   opensAt        : ISO string   — when the booking window opens
//   warmupAt       : ISO string   — when warm-up should begin
//   armedAt        : ISO string   — when armed posture begins
//   phase          : "waiting" | "warmup" | "armed" | "executing" | "confirming"
//   msUntilOpen    : number       — ms until opensAt (negative when past)
//   msUntilWarmup  : number       — ms until warmupAt (negative when past)
//   msUntilArmed   : number       — ms until armedAt (negative when past)
// }
//
// Log prefix: [execution-timing]

'use strict';

const { getBookingWindow } = require('./booking-window');

// ── Configurable offsets ──────────────────────────────────────────────────────
// Stage 10F may apply small learned adjustments on top of these.

const WARMUP_OFFSET_MS = 3 * 60 * 1000;  // 3 minutes before window opens
const ARMED_OFFSET_MS  =     45 * 1000;  // 45 seconds before window opens

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute execution-level timing phase for a job.
 *
 * @param {object} job            DB job row (classTime/class_time, dayOfWeek/day_of_week, etc.)
 * @param {object} [opts]
 * @param {Date}   [opts.now]          Override current time (for testing). Default: new Date().
 * @param {boolean}[opts.isConfirming] True while awaiting booking confirmation (Stage 10E).
 * @param {number} [opts.warmupOffsetOverrideMs]  Learned offset from Stage 10F.
 * @param {number} [opts.armedOffsetOverrideMs]   Learned offset from Stage 10F.
 * @returns {{ opensAt, warmupAt, armedAt, phase, msUntilOpen, msUntilWarmup, msUntilArmed }}
 */
function computeExecutionTiming(job, {
  now               = new Date(),
  isConfirming      = false,
  warmupOffsetOverrideMs = null,
  armedOffsetOverrideMs  = null,
} = {}) {
  const { bookingOpen } = getBookingWindow(job);

  const opensAt  = bookingOpen;
  const warmupMs = warmupOffsetOverrideMs ?? WARMUP_OFFSET_MS;
  const armedMs  = armedOffsetOverrideMs  ?? ARMED_OFFSET_MS;

  const warmupAt = new Date(opensAt.getTime() - warmupMs);
  const armedAt  = new Date(opensAt.getTime() - armedMs);

  const msUntilOpen   = opensAt.getTime()  - now.getTime();
  const msUntilWarmup = warmupAt.getTime() - now.getTime();
  const msUntilArmed  = armedAt.getTime()  - now.getTime();

  // Phase computation (priority order matches header spec).
  let phase;
  if (now < warmupAt) {
    phase = 'waiting';
  } else if (now < armedAt) {
    phase = 'warmup';
  } else if (now < opensAt) {
    phase = 'armed';
  } else if (isConfirming) {
    phase = 'confirming';
  } else {
    phase = 'executing';
  }

  return {
    opensAt:       opensAt.toISOString(),
    warmupAt:      warmupAt.toISOString(),
    armedAt:       armedAt.toISOString(),
    phase,
    msUntilOpen,
    msUntilWarmup,
    msUntilArmed,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { computeExecutionTiming, WARMUP_OFFSET_MS, ARMED_OFFSET_MS };
