/**
 * Time utility helpers — explicit epoch vs duration semantics.
 *
 * Terminology used throughout this codebase:
 *   EpochMs    — milliseconds since Unix epoch (absolute point in time).
 *                e.g. bookingOpenEpochMs, job.bookingOpenMs
 *   DurationMs — milliseconds relative to "now" (a span of time, may be negative).
 *                e.g. msUntilOpen, countdown differences
 *
 * Use these helpers to make the conversion intent explicit and prevent
 * the class of bug where an EpochMs is accidentally added to Date.now().
 */

/**
 * Convert an absolute epoch timestamp to a Date object.
 * Use for: bookingOpenEpochMs, any server-side .getTime() value.
 */
export function epochMsToDate(epochMs: number | null | undefined): Date | null {
  return epochMs != null ? new Date(epochMs) : null
}

/**
 * Convert a relative duration (ms from now) to a Date object.
 * Use for: msUntilOpen, countdown offsets.
 */
export function durationMsToDate(msFromNow: number | null | undefined): Date | null {
  return msFromNow != null ? new Date(Date.now() + msFromNow) : null
}

/**
 * Format a Date object as a locale time string (e.g. "9:00 AM").
 * Returns '' when date is null.
 */
export function formatTime(date: Date | null): string {
  return date
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : ''
}
