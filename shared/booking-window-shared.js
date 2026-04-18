// Shared booking-window math — single source of truth for both the Node
// server and the React client.
//
// Task #77: previously these constants and the phase-derivation logic lived
// in TWO places (src/scheduler/booking-window.js for Node and
// client/src/screens/NowScreen.tsx for the client) and had already drifted
// on at least one constant.  Server bug fixes were silently undone whenever
// the client fell back to its own copy.  This module is the canonical home;
// both sides import from here.
//
// Plain CommonJS (no `type: module` in package.json), so Node `require()`s
// it directly.  Vite/TS on the client side imports it through interop —
// see shared/booking-window-shared.d.ts for the typed surface.

// ── Business-rule constants ───────────────────────────────────────────────

/** Days before the class that registration opens. */
const BOOKING_LEAD_DAYS    = 3;

/** Minutes before class start that registration opens (on the lead day). */
const BOOKING_LEAD_MINUTES = 60;

/** Convenience: total milliseconds before class-start that booking opens. */
const BOOKING_LEAD_MS =
  (BOOKING_LEAD_DAYS * 24 * 60 * 60 * 1000) +
  (BOOKING_LEAD_MINUTES *      60 * 1000);

/** Phase boundaries, expressed as ms-until-booking-opens. */
const WARMUP_MS = 10 * 60 * 1000; // 10 min before open → spin up the browser
const SNIPER_MS =  1 * 60 * 1000; //  1 min before open → poll aggressively

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Phase derivation ──────────────────────────────────────────────────────

/**
 * Derive a coarse scheduler phase from how far away booking-open is.
 *
 *   "too_early" — more than WARMUP_MS away
 *   "warmup"    — between WARMUP_MS and SNIPER_MS
 *   "sniper"    — within SNIPER_MS, still in the future
 *   "late"      — booking-open already passed
 *   "unknown"   — caller could not compute msUntilOpen
 */
function derivePhase(msUntilOpen) {
  if (msUntilOpen == null || Number.isNaN(msUntilOpen)) return 'unknown';
  if (msUntilOpen > WARMUP_MS) return 'too_early';
  if (msUntilOpen > SNIPER_MS) return 'warmup';
  if (msUntilOpen > 0)         return 'sniper';
  return 'late';
}

// ── Time parsing ──────────────────────────────────────────────────────────

/** Parse "7:45 AM" → { hours: 7, minutes: 45 }.  Returns null on failure. */
function parseClassTime(classTime) {
  if (!classTime || typeof classTime !== 'string') return null;
  const m = classTime.trim().match(/^(\d+):(\d+)\s*(am|pm)$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

// ── Pacific-time helpers ──────────────────────────────────────────────────

/** UTC offset in hours for America/Los_Angeles at the given Date. */
function pacificOffsetHours(date) {
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const m = tz.match(/GMT([+-])(\d+)/);
  return m ? parseInt(m[1] + m[2], 10) : -7;
}

// ── Class-start computation ───────────────────────────────────────────────

/**
 * Compute the next class-start epoch ms in Pacific time from a job-shaped
 * input.  Accepts either snake_case (DB rows) or camelCase (typed JS) keys.
 *
 *   { class_time | classTime, target_date | targetDate, day_of_week | dayOfWeek }
 *
 * If `target_date` is set, it pins the calendar date.  Otherwise the next
 * weekday occurrence is used (rolls forward if today's class already passed).
 *
 * Returns null if required fields are missing/unparseable.
 */
function computeClassStartMs(job, now = new Date()) {
  if (!job) return null;
  const time = parseClassTime(job.class_time || job.classTime);
  if (!time) return null;
  const targetDate = job.target_date || job.targetDate;

  if (targetDate) {
    const [y, m, d] = String(targetDate).split('-').map(Number);
    if (!y || !m || !d) return null;
    const approx = new Date(Date.UTC(y, m - 1, d, 12, 0));
    const offset = pacificOffsetHours(approx);
    return Date.UTC(y, m - 1, d, time.hours - offset, time.minutes);
  }

  const dayOfWeek = job.day_of_week || job.dayOfWeek;
  if (dayOfWeek == null) return null;
  let targetDow = DAYS.indexOf(dayOfWeek);
  if (targetDow === -1) {
    const n = parseInt(dayOfWeek, 10);
    if (!isNaN(n) && n >= 0 && n <= 6) targetDow = n;
    else return null;
  }

  // Read current date components in Pacific via Intl, then build target ms.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'long',  hour: 'numeric',  minute: 'numeric', hour12: false,
  });
  const get = type => fmt.formatToParts(now).find(p => p.type === type).value;
  const pacYear   = parseInt(get('year'),   10);
  const pacMonth  = parseInt(get('month'),  10) - 1;
  const pacDay    = parseInt(get('day'),    10);
  const pacHour   = parseInt(get('hour'),   10) % 24;
  const pacMinute = parseInt(get('minute'), 10);
  const todayDow  = DAYS.indexOf(get('weekday'));

  let daysUntil = (targetDow - todayDow + 7) % 7;
  if (daysUntil === 0 &&
      (pacHour > time.hours || (pacHour === time.hours && pacMinute >= time.minutes))) {
    daysUntil = 7;
  }

  const approx = new Date(Date.UTC(pacYear, pacMonth, pacDay + daysUntil, 12, 0));
  const offset = pacificOffsetHours(approx);
  return Date.UTC(pacYear, pacMonth, pacDay + daysUntil, time.hours - offset, time.minutes);
}

/**
 * Compute the booking-open epoch ms — i.e. when registration opens for the
 * given job's next class.  Subtracts BOOKING_LEAD_MS from the class-start.
 * Returns null if the class-start cannot be computed.
 */
function computeBookingOpenMs(job, now = new Date()) {
  const classStart = computeClassStartMs(job, now);
  if (classStart == null) return null;
  return classStart - BOOKING_LEAD_MS;
}

// Individual named-export assignments (rather than a single
// `module.exports = { ... }` literal) so Vite/esbuild's CJS-to-ESM
// analyzer can statically detect each export.  Some Vite versions stop
// honouring named ESM imports against the object-literal form.
module.exports.BOOKING_LEAD_DAYS    = BOOKING_LEAD_DAYS;
module.exports.BOOKING_LEAD_MINUTES = BOOKING_LEAD_MINUTES;
module.exports.BOOKING_LEAD_MS      = BOOKING_LEAD_MS;
module.exports.WARMUP_MS            = WARMUP_MS;
module.exports.SNIPER_MS            = SNIPER_MS;
module.exports.derivePhase          = derivePhase;
module.exports.parseClassTime       = parseClassTime;
module.exports.computeClassStartMs  = computeClassStartMs;
module.exports.computeBookingOpenMs = computeBookingOpenMs;
module.exports.pacificOffsetHours   = pacificOffsetHours;
