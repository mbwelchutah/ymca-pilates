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
 * Returns the Pacific UTC offset in hours at the given Date.
 * e.g. -7 during PDT (summer), -8 during PST (winter).
 * Uses Intl so it correctly handles daylight saving transitions.
 */
function pacificOffset(date) {
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-7"
  const m = tz.match(/GMT([+-])(\d+)/);
  return m ? parseInt(m[1] + m[2], 10) : -7;
}

/**
 * Returns the next occurrence of dayOfWeek at the given hour/minute IN PACIFIC TIME,
 * starting from `now`. If today is that day but the time has passed, returns next week.
 *
 * Bug fix: the old code used setHours() which uses the SYSTEM local timezone.
 * On a UTC server, setHours(7, 45) = 7:45 UTC = 00:45 PDT — wrong.
 * Fix: read today's date components in Pacific via Intl, then use Date.UTC()
 * with the Pacific offset applied, so the system timezone is never involved.
 */
function nextOccurrence(dayOfWeek, hours, minutes, now) {
  let targetDay = DAYS.indexOf(dayOfWeek);
  if (targetDay === -1) {
    const n = parseInt(dayOfWeek, 10);
    if (!isNaN(n) && n >= 0 && n <= 6) targetDay = n;
    else throw new Error('Unknown day_of_week: ' + dayOfWeek);
  }

  // Read the current date/time components in Pacific timezone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  });
  const get = type => fmt.formatToParts(now).find(p => p.type === type).value;

  const pacYear    = parseInt(get('year'),   10);
  const pacMonth   = parseInt(get('month'),  10) - 1; // 0-indexed for Date.UTC
  const pacDay     = parseInt(get('day'),    10);
  const pacHour    = parseInt(get('hour'),   10) % 24; // guard against "24" at midnight
  const pacMinute  = parseInt(get('minute'), 10);

  const shortDays  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayIndex = shortDays.indexOf(get('weekday'));
  let daysUntil    = (targetDay - todayIndex + 7) % 7;

  // If today is target day but class time has already passed, use next week
  if (daysUntil === 0 &&
      (pacHour > hours || (pacHour === hours && pacMinute >= minutes))) {
    daysUntil = 7;
  }

  // Build a UTC Date representing hours:minutes Pacific on the target calendar day.
  // Date.UTC handles day overflow (e.g. pacDay + 5 rolling past month end) correctly.
  const targetDayUTC = new Date(Date.UTC(pacYear, pacMonth, pacDay + daysUntil));
  const offset       = pacificOffset(targetDayUTC); // e.g. -7 for PDT
  // 7:45 AM Pacific at UTC-7 → UTC hour = 7 - (-7) = 14
  return new Date(Date.UTC(pacYear, pacMonth, pacDay + daysUntil, hours - offset, minutes));
}

/**
 * Given a DB job row, returns:
 *   nextClass    — Date of next class occurrence
 *   bookingOpen  — Date when registration opens (3 days before, 1 hr before class)
 *
 * If the job has a target_date (YYYY-MM-DD), the booking window is computed
 * relative to that specific date rather than the next natural weekday occurrence.
 * This ensures the scheduler phases (too_early / warmup / sniper / late) align
 * with what the bot is actually going to try to book.
 */
function getBookingWindow(job) {
  const { hours, minutes } = parseTime(job.classTime || job.class_time);
  const targetDate = job.targetDate || job.target_date;

  let nextClass;
  if (targetDate) {
    // Parse YYYY-MM-DD and place the class at hours:minutes in Pacific time.
    const [y, m, d] = targetDate.split('-').map(Number);
    // Use noon UTC on the target date to determine the Pacific offset that day.
    const approxDate = new Date(Date.UTC(y, m - 1, d, 12, 0));
    const offset     = pacificOffset(approxDate); // e.g. -7 for PDT, -8 for PST
    nextClass = new Date(Date.UTC(y, m - 1, d, hours - offset, minutes));
  } else {
    const now = new Date();
    nextClass = nextOccurrence(job.dayOfWeek || job.day_of_week, hours, minutes, now);
  }

  const bookingOpen = new Date(nextClass.getTime());
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

/**
 * Returns true when the given job is a one-off (target_date set) whose class
 * date+time has already passed in Pacific time.  Recurring jobs (no target_date)
 * always return false because nextOccurrence() rolls them forward automatically.
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

module.exports = { getBookingWindow, getPhase, parseTime, nextOccurrence, isPastClass };
