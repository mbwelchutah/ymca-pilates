import { useState, useEffect, useCallback, useRef } from 'react'
import type { AppState } from '../types'
import { api } from '../lib/api'

const DEFAULT_STATE: AppState = {
  schedulerPaused: false,
  dryRun: true,
  jobs: [],
}

// How many consecutive failures before the error is surfaced to the user.
// At a 5 s poll interval this gives a ~15 s silent grace period on startup or
// brief server restarts before anything red appears on screen.
const ERROR_GRACE_RETRIES = 3

export function useAppState() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Counts consecutive failures so transient startup gaps don't flash errors.
  const failCount = useRef(0)
  // True once we have had at least one successful fetch.
  const hasLoaded = useRef(false)
  // Tracks jobs that disappeared from a single poll response — if they reappear
  // on the very next poll, the disappearance was a transient server read (e.g.
  // a pg-sync restore race), NOT a legitimate delete.  Guards against the
  // "ghost class disappears and comes back" flicker observed on Apr 16.
  const pendingDisappearance = useRef<Map<number, { job: AppState['jobs'][number]; seenAt: number }>>(new Map())
  const MAX_GHOST_RETENTION_MS = 8000 // ~1-2 poll cycles at 5 s interval

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.getState()
      // Merge: any job that existed on the previous load but is absent now gets
      // a one-cycle grace period before disappearing from the UI.  If it comes
      // back on the next poll, the "disappearance" was a transient server read.
      // If it doesn't come back within MAX_GHOST_RETENTION_MS, we drop it.
      // Using setState(prev => ...) so `prev.jobs` is always the latest state,
      // not a stale closure from when refresh was created.
      setState(prev => {
        const now = Date.now()
        const freshIds = new Set((fresh.jobs || []).map(j => j.id))
        // Add newly-missing jobs to the pending map.
        for (const p of prev.jobs || []) {
          if (p.id != null && !freshIds.has(p.id) && !pendingDisappearance.current.has(p.id)) {
            pendingDisappearance.current.set(p.id, { job: p, seenAt: now })
          }
        }
        // Remove from pending any job that came back.
        for (const id of Array.from(pendingDisappearance.current.keys())) {
          if (freshIds.has(id)) pendingDisappearance.current.delete(id)
        }
        // Expire stale pendings.
        for (const [id, rec] of Array.from(pendingDisappearance.current.entries())) {
          if (now - rec.seenAt > MAX_GHOST_RETENTION_MS) pendingDisappearance.current.delete(id)
        }
        // Compose: fresh jobs + any still-pending disappeared jobs (preserved
        // temporarily so their card doesn't flicker out of the list).
        const retained = Array.from(pendingDisappearance.current.values()).map(r => r.job)
        const mergedJobs = retained.length > 0 ? [...(fresh.jobs || []), ...retained] : (fresh.jobs || [])
        return { ...fresh, jobs: mergedJobs }
      })
      setError(null)
      failCount.current = 0
      hasLoaded.current = true
    } catch (e) {
      failCount.current += 1
      // Only show an error after several consecutive failures so a brief
      // restart or slow cold-start doesn't immediately break the UI.
      if (failCount.current > ERROR_GRACE_RETRIES) {
        setError(e instanceof Error ? e.message : 'Failed to load state')
        setLoading(false) // stop the spinner once we surface the error
      }
      // If we have previously loaded good data, keep showing it (don't blank
      // the screen on a transient error).
    } finally {
      // Keep the loading spinner until the first successful fetch (or until
      // the grace period expires and we show an error above).
      if (hasLoaded.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  return { state, loading, error, refresh }
}
