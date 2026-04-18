// Task #81 — "Showing last known state" pill rendered at the top of Tools
// and Settings whenever a tracked endpoint reports a degraded `meta` block,
// or the most recent client poll for one of those endpoints failed.
//
// Intentionally compact: a single amber row that doesn't disrupt layout when
// the screen is healthy (the parent only mounts this when `show` is true).
//
// Task #88 — also accepts an optional `ageSeconds` describing how old the
// underlying snapshot is, so the pill can show "· 2m ago" and let the user
// decide whether to wait or act.
//
// Task #89 — when an `onRetry` handler is supplied the pill becomes a button
// that triggers a manual refetch of the affected endpoints.  While the
// refetch is in-flight a small inline spinner replaces the status dot; on
// success the parent will unmount the pill (because the staleness signal
// clears), and on failure the pill stays visible so the user can try again.

import { useState } from 'react'

interface StaleStatePillProps {
  reason?: string | null
  ageSeconds?: number | null
  onRetry?: () => Promise<unknown> | void
}

function humaniseAge(seconds: number): string {
  // Floor at each unit boundary so we never overstate how old the snapshot
  // is — "how stale it actually is" should err on the side of looking
  // fresher rather than older.
  const s = Math.max(0, Math.floor(seconds))
  if (s < 5)       return 'just now'
  if (s < 60)      return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)      return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)      return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function StaleStatePill({ reason, ageSeconds, onRetry }: StaleStatePillProps) {
  const [isRetrying, setIsRetrying] = useState(false)

  const handleRetry = async () => {
    if (!onRetry || isRetrying) return
    setIsRetrying(true)
    try {
      await onRetry()
    } finally {
      setIsRetrying(false)
    }
  }

  const ageSuffix =
    typeof ageSeconds === 'number' && Number.isFinite(ageSeconds)
      ? ` · ${humaniseAge(ageSeconds)}`
      : ''

  const baseClasses =
    'mx-1 mt-1 mb-2 px-3 py-1.5 rounded-full bg-accent-amber/10 border border-accent-amber/30 inline-flex items-center gap-2'

  const content = (
    <>
      {isRetrying ? (
        <span
          data-testid="stale-state-pill-spinner"
          className="w-3 h-3 rounded-full border-[1.5px] border-accent-amber/30 border-t-accent-amber animate-spin"
          aria-hidden="true"
        />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />
      )}
      <span className="text-[12px] font-medium text-accent-amber">
        {isRetrying
          ? 'Refreshing…'
          : `Showing last known state${ageSuffix}${reason ? ` — ${reason}` : ''}`}
      </span>
    </>
  )

  if (onRetry) {
    return (
      <button
        type="button"
        data-testid="stale-state-pill"
        onClick={handleRetry}
        disabled={isRetrying}
        aria-label="Retry — refresh now"
        aria-busy={isRetrying}
        className={`${baseClasses} cursor-pointer active:opacity-70 disabled:cursor-default`}
      >
        {content}
      </button>
    )
  }

  return (
    <div data-testid="stale-state-pill" className={baseClasses}>
      {content}
    </div>
  )
}
