// Booking window calculator (Node side).
//
// Business rules (Eugene YMCA Core Pilates):
//   - Registration opens exactly 3 days before the class, at 1 hour before class start.
//   - Example: Wed class at 7:45 AM → booking opens Sun at 6:45 AM.
//
// Phases returned by getPhase():
//   "too_early" — more than 10 minutes before booking opens, just wait
//   "warmup"    — 10 min to 1 min before open, spin up the browser early
//   "sniper"    — within 1 min of open, poll aggressively and click immediately
//   "late"      — booking open time has already passed (may still be registerable)
//
// Timezone assumption: all times are interpreted as America/Los_Angeles (Pacific).
// The DB stores class_time as "7:45 AM" and day_of_week as "Wednesday".
//
// Task #77: the constants and the phase-derivation step now live in
// shared/booking-window-shared.js so the React client can import the
// exact same math and stop drifting.  This file keeps the Node-only
// public API (getBookingWindow / getPhase / isPastClass / parseTime /
// nextOccurrence) so existing callers don't change.

const {
  BOOKING_LEAD_DAYS,
  BOOKING_LEAD_MINUTES,
  WARMUP_MS,
  SNIPER_MS,
  derivePhase,
  parseClassTime,
  computeClassStartMs,
} = require('../../shared/booking-window-shared');

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Parse "7:45 AM" → { hours: 7, minutes: 45 }.
 * Re-exported for back-compat; throws on parse failure to preserve old
 * caller behaviour.  Internally delegates to the shared parser.
 */
function parseTime(classTime) {
  const parsed = parseClassTime(classTime);
  if (!parsed) throw new Error('Cannot parse class_time: ' + classTime);
  return parsed;
}

/**
 * Returns the next occurrence of dayOfWeek at the given hour/minute IN PACIFIC TIME,
 * starting from `now`.  Thin wrapper over shared.computeClassStartMs for back-compat
 * (some callers/tests still import nextOccurrence directly).
 */
function nextOccurrence(dayOfWeek, hours, minutes, now) {
  // Build a minimal job-shaped input and delegate to the shared module so
  // the Pacific/Intl/DST handling lives in exactly one place.
  const ms = computeClassStartMs(
    {
      day_of_week: dayOfWeek,
      class_time: `${((hours + 11) % 12) + 1}:${String(minutes).padStart(2,'0')} ${hours < 12 ? 'AM' : 'PM'}`,
    },
    now,
  );
  if (ms == null) throw new Error('Unknown day_of_week: ' + dayOfWeek);
  return new Date(ms);
}

/**
 * Given a DB job row, returns:
 *   nextClass    — Date of next class occurrence
 *   bookingOpen  — Date when registration opens (3 days before, 1 hr before class)
 *
 * If the job has a target_date (YYYY-MM-DD), the booking window is computed
 * relative to that specific date rather than the next natural weekday occurrence.
 */
function getBookingWindow(job) {
  const classStartMs = computeClassStartMs(job);
  if (classStartMs == null) {
    // Reproduce the legacy parse-failure message the old code threw, so
    // upstream try/catches that look at .message keep working.
    throw new Error('Cannot parse class_time: ' + (job.classTime || job.class_time));
  }
  const nextClass   = new Date(classStartMs);
  const bookingOpen = new Date(classStartMs);
  bookingOpen.setDate(bookingOpen.getDate() - BOOKING_LEAD_DAYS);
  bookingOpen.setMinutes(bookingOpen.getMinutes() - BOOKING_LEAD_MINUTES);
  return { nextClass, bookingOpen };
}

/**
 * Returns the current phase based on how far away booking open is.
 *   "too_early" | "warmup" | "sniper" | "late"
 */
function getPhase(job) {
  const { nextClass, bookingOpen } = getBookingWindow(job);
  const msUntilOpen = bookingOpen - new Date();
  return { phase: derivePhase(msUntilOpen), nextClass, bookingOpen, msUntilOpen };
}

/**
 * Returns true when the given job is a one-off (target_date set) whose class
 * date+time has already passed in Pacific time.  Recurring jobs (no target_date)
 * always return false because the next-occurrence helper rolls them forward.
 */
function isPastClass(job) {
  const targetDate = job.targetDate || job.target_date;
  if (!targetDate) return false;
  try {
    const { nextClass } = getBookingWindow(job);
    return nextClass.getTime() < Date.now();
  } catch (_) {
    return false;
  }
}

module.exports = {
  // Original public API (unchanged):
  getBookingWindow, getPhase, parseTime, nextOccurrence, isPastClass,
  // Re-export the shared constants/helpers so Node callers that need the
  // raw numbers don't have to know about shared/ — single import surface.
  BOOKING_LEAD_DAYS, BOOKING_LEAD_MINUTES, WARMUP_MS, SNIPER_MS, derivePhase,
};
