// Shared booking-cycle helpers used by both Plan and Now screens.
//
// "Current cycle" means the booking is still associated with an upcoming or
// same-week class occurrence — not a past run that has already happened and
// cycled into the next week.

/**
 * Returns true if the ISO timestamp falls within the current calendar week
 * (Monday 00:00 UTC through Sunday 23:59 UTC).
 *
 * Used by both Plan and Now to decide whether a "booked" or "dry_run" result
 * badge is still relevant to the current booking cycle.
 */
export function isThisWeekUTC(isoStr: string | null | undefined): boolean {
  if (!isoStr) return false
  const successDate  = new Date(isoStr)
  const now          = new Date()
  const daysSinceMon = (now.getUTCDay() + 6) % 7
  const weekStart    = new Date(now)
  weekStart.setUTCHours(0, 0, 0, 0)
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon)
  return successDate >= weekStart
}
