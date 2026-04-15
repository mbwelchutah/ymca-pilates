/**
 * job-consistency.js
 *
 * Validates that a job's stored day_of_week label agrees with the actual
 * calendar weekday of its target_date.  Returns a structured result so
 * callers can surface warnings without mutating job data.
 *
 * Used in the /api/state enrichment path so every job response carries a
 * weekdayConsistency field that the UI and bot can inspect.
 */

const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

/**
 * Normalise a day label to title-case full name, e.g.:
 *   "tuesday" → "Tuesday"
 *   "Tue"     → "Tuesday"
 *   "THURSDAY"→ "Thursday"
 * Returns null if the input cannot be matched.
 */
function normaliseDayLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return DAYS.find(d => d.toLowerCase() === s || d.toLowerCase().startsWith(s.slice(0, 3))) || null;
}

/**
 * checkJobConsistency(job)
 *
 * @param {object} job  A DB job row (may use snake_case or camelCase keys).
 * @returns {{
 *   isConsistent:    boolean,
 *   storedWeekday:   string|null,   // normalised value of day_of_week
 *   computedWeekday: string|null,   // weekday derived from target_date
 *   mismatchReason:  string|null,   // human-readable explanation if inconsistent
 * }}
 */
function checkJobConsistency(job) {
  const targetDate = job.target_date || job.targetDate || null;
  const storedRaw  = job.day_of_week || job.dayOfWeek || null;
  const storedWeekday   = normaliseDayLabel(storedRaw);
  let   computedWeekday = null;
  let   mismatchReason  = null;

  if (!targetDate) {
    // No target_date — nothing to cross-check; recurring jobs are always consistent.
    return { isConsistent: true, storedWeekday, computedWeekday, mismatchReason };
  }

  // Parse YYYY-MM-DD as UTC to avoid local-timezone day shifts.
  const d = new Date(targetDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) {
    return {
      isConsistent: false,
      storedWeekday,
      computedWeekday: null,
      mismatchReason: `target_date "${targetDate}" is not a valid date`,
    };
  }

  computedWeekday = DAYS[d.getUTCDay()];

  if (!storedWeekday) {
    // Cannot validate — stored label is missing or unrecognised.
    return {
      isConsistent: false,
      storedWeekday: storedRaw || null,
      computedWeekday,
      mismatchReason: `day_of_week "${storedRaw}" is not a recognised weekday name`,
    };
  }

  if (storedWeekday !== computedWeekday) {
    mismatchReason =
      `stored weekday "${storedWeekday}" does not match ` +
      `target_date ${targetDate} which falls on ${computedWeekday}`;
    return { isConsistent: false, storedWeekday, computedWeekday, mismatchReason };
  }

  return { isConsistent: true, storedWeekday, computedWeekday, mismatchReason: null };
}

module.exports = { checkJobConsistency, normaliseDayLabel };
