// Booking window calculator.
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

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// How many days before the class registration opens.
const BOOKING_LEAD_DAYS = 3;

// How many minutes before class start registration opens (same day as lead day).
const BOOKING_LEAD_MINUTES = 60;

// Phase thresholds in milliseconds.
const WARMUP_MS  = 10 * 60 * 1000; // 10 minutes before open
const SNIPER_MS  =  1 * 60 * 1000; //  1 minute before open

/**
 * Parse "7:45 AM" → { hours: 7, minutes: 45 }
 */
function parseTime(classTime) {
  const m = classTime.trim().match(/^(\d+):(\d+)\s*(am|pm)$/i);
  if (!m) throw new Error('Cannot parse class_time: ' + classTime);
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

/**
 * Returns the next occurrence of dayOfWeek at the given hour/minute,
 * starting from `now`. If today is that day but the time has passed, returns next week.
 */
function nextOccurrence(dayOfWeek, hours, minutes, now) {
  const targetDay = DAYS.indexOf(dayOfWeek);
  if (targetDay === -1) throw new Error('Unknown day_of_week: ' + dayOfWeek);

  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(hours, minutes, 0, 0);

  const todayDay = now.getDay();
  let daysUntil = (targetDay - todayDay + 7) % 7;

  // If today is the target day but the time has already passed, go to next week
  if (daysUntil === 0 && now >= result) daysUntil = 7;

  result.setDate(result.getDate() + daysUntil);
  return result;
}

/**
 * Given a DB job row, returns:
 *   nextClass    — Date of next class occurrence
 *   bookingOpen  — Date when registration opens (3 days before, 1 hr before class)
 */
function getBookingWindow(job) {
  const { hours, minutes } = parseTime(job.classTime || job.class_time);
  const now = new Date();
  const nextClass = nextOccurrence(job.dayOfWeek || job.day_of_week, hours, minutes, now);

  const bookingOpen = new Date(nextClass);
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
  const now = new Date();
  const msUntilOpen = bookingOpen - now;

  let phase;
  if (msUntilOpen > WARMUP_MS)  phase = 'too_early';
  else if (msUntilOpen > SNIPER_MS) phase = 'warmup';
  else if (msUntilOpen > 0)     phase = 'sniper';
  else                           phase = 'late';

  return { phase, nextClass, bookingOpen, msUntilOpen };
}

module.exports = { getBookingWindow, getPhase, parseTime, nextOccurrence };
