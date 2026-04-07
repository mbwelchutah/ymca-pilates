import { useState, useEffect, useCallback, useRef } from 'react'
import type { AppState } from '../types'
import { api } from '../lib/api'

const DEFAULT_STATE: AppState = {
  schedulerPaused: false,
  dryRun: true,
  selectedJobId: null,
  phase: 'unknown',
  bookingOpenMs: null,
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

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.getState()
      setState(fresh)
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
