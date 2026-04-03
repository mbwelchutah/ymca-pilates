import { useState, useEffect, useCallback } from 'react'
import type { AppState } from '../types'
import { api } from '../lib/api'

const DEFAULT_STATE: AppState = {
  schedulerPaused: false,
  dryRun: true,
  selectedJobId: null,
  jobs: [],
}

export function useAppState() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.getState()
      setState(fresh)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load state')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  return { state, loading, error, refresh }
}
