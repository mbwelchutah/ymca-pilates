// ESM mirror of shared/booking-window-shared.js — same constants, same
// helpers, in browser-native ESM so Vite can serve it without any
// CJS-to-ESM transform.
//
// Why two files?  The Node side is heavily CJS (every consumer of
// src/scheduler/booking-window.js uses `require()`), and Node 20 cannot
// `require()` an ESM module synchronously.  Vite, on the other hand,
// only serves files outside its `root: 'client'` raw — it does not
// transform a CJS .js file to ESM, so the browser cannot resolve named
// imports from the .js file.
//
// Both files are pinned to the same values by
// tests/booking-window-shared.test.js (CJS↔ESM equivalence assertions).

// ── Business-rule constants ───────────────────────────────────────────────

/** Days before the class that registration opens. */
export const BOOKING_LEAD_DAYS    = 3;

/** Minutes before class start that registration opens (on the lead day). */
export const BOOKING_LEAD_MINUTES = 60;

/** Convenience: total milliseconds before class-start that booking opens. */
export const BOOKING_LEAD_MS =
  (BOOKING_LEAD_DAYS * 24 * 60 * 60 * 1000) +
  (BOOKING_LEAD_MINUTES *      60 * 1000);

/** Phase boundaries, expressed as ms-until-booking-opens. */
export const WARMUP_MS = 10 * 60 * 1000; // 10 min before open → spin up the browser
export const SNIPER_MS =  1 * 60 * 1000; //  1 min before open → poll aggressively

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Phase derivation ──────────────────────────────────────────────────────

export function derivePhase(msUntilOpen) {
  if (msUntilOpen == null || Number.isNaN(msUntilOpen)) return 'unknown';
  if (msUntilOpen > WARMUP_MS) return 'too_early';
  if (msUntilOpen > SNIPER_MS) return 'warmup';
  if (msUntilOpen > 0)         return 'sniper';
  return 'late';
}

// ── Time parsing ──────────────────────────────────────────────────────────

export function parseClassTime(classTime) {
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

export function pacificOffsetHours(date) {
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const m = tz.match(/GMT([+-])(\d+)/);
  return m ? parseInt(m[1] + m[2], 10) : -7;
}

// ── Class-start computation ───────────────────────────────────────────────

export function computeClassStartMs(job, now = new Date()) {
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

export function computeBookingOpenMs(job, now = new Date()) {
  const classStart = computeClassStartMs(job, now);
  if (classStart == null) return null;
  return classStart - BOOKING_LEAD_MS;
}
