/**
 * Shared "booking window opens" formatting.
 * Canonical format: "Opens today at 10:20 PM" / "Opens Apr 14 at 10:20 PM"
 * Used by PlanScreen (timing line) and NowScreen (hero card caption).
 */

/**
 * Returns the relative date+time portion WITHOUT the "Opens" prefix, e.g.:
 *   "today at 10:20 PM"
 *   "tomorrow at 10:20 PM"
 *   "Apr 14 at 10:20 PM"
 *   "Apr 14"  (if ms is in the past — time is no longer useful)
 */
export function formatOpensRelative(ms: number): string {
  const now  = Date.now()
  const d    = new Date(ms)
  const time = d.toLocaleString([], { hour: 'numeric', minute: '2-digit' })
  const date = d.toLocaleString([], { month: 'short', day: 'numeric' })

  if (ms < now) return date

  const todayMidnight    = new Date(); todayMidnight.setHours(0, 0, 0, 0)
  const tomorrowMidnight = new Date(todayMidnight); tomorrowMidnight.setDate(todayMidnight.getDate() + 1)
  const dayAfterMidnight = new Date(tomorrowMidnight); dayAfterMidnight.setDate(tomorrowMidnight.getDate() + 1)

  if (ms < tomorrowMidnight.getTime()) return `today at ${time}`
  if (ms < dayAfterMidnight.getTime()) return `tomorrow at ${time}`
  return `${date} at ${time}`
}

/**
 * Full "Opens today at 10:20 PM" / "Opened Apr 14" string.
 * Canonical opening-window label for both Plan cards and Now hero caption.
 */
export function formatOpens(ms: number): string {
  const rel = formatOpensRelative(ms)
  if (ms < Date.now()) return `Opened ${rel}`
  return `Opens ${rel}`
}
