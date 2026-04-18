// Task #81 — "Showing last known state" pill rendered at the top of Tools
// and Settings whenever a tracked endpoint reports a degraded `meta` block,
// or the most recent client poll for one of those endpoints failed.
//
// Intentionally compact: a single amber row that doesn't disrupt layout when
// the screen is healthy (the parent only mounts this when `show` is true).

interface StaleStatePillProps {
  reason?: string | null
}

export function StaleStatePill({ reason }: StaleStatePillProps) {
  return (
    <div
      data-testid="stale-state-pill"
      className="mx-1 mt-1 mb-2 px-3 py-1.5 rounded-full bg-accent-amber/10 border border-accent-amber/30 inline-flex items-center gap-2"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-accent-amber" />
      <span className="text-[12px] font-medium text-accent-amber">
        Showing last known state{reason ? ` — ${reason}` : ''}
      </span>
    </div>
  )
}
