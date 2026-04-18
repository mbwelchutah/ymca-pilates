import { useEffect, useRef, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import { StaleStatePill } from '../components/ui/StaleStatePill'
import type { AppState, AuthStatusEnum } from '../types'
import { api } from '../lib/api'

interface SettingsScreenProps {
  appState: AppState
  refresh: () => void | Promise<void>
  onSessionRefresh?: () => void
  onAccount?: () => void
  accountAttention?: boolean
  authStatus?: AuthStatusEnum | null
  tab?: import('../components/nav/TabBar').Tab
  onTabChange?: (tab: import('../components/nav/TabBar').Tab) => void
  scrolled?: boolean
  // Task #81 — true while the most recent /api/state poll failed.
  pollFailed?: boolean
}

export function SettingsScreen({ appState, refresh, onSessionRefresh, onAccount, accountAttention, authStatus, tab = 'settings', onTabChange = () => {}, scrolled = false, pollFailed = false }: SettingsScreenProps) {
  const [clearing,     setClearing]     = useState(false)
  const [clearFeedback, setClearFeedback] = useState<{ text: string; cls: string } | null>(null)
  // Task #81 — surface inline "Couldn't reach server" feedback under each
  // toggle when the fire-and-forget API call rejects, instead of letting the
  // toggle silently snap back to the server-confirmed value with no signal.
  const [dryRunErr,    setDryRunErr]    = useState<string | null>(null)
  const [pauseErr,     setPauseErr]     = useState<string | null>(null)
  const dryRunErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pauseErrTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (dryRunErrTimer.current) clearTimeout(dryRunErrTimer.current)
    if (pauseErrTimer.current)  clearTimeout(pauseErrTimer.current)
  }, [])

  const flashError = (
    msg: string,
    setter: (v: string | null) => void,
    timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setter(msg)
    timerRef.current = setTimeout(() => setter(null), 4000)
  }

  const handleDryRun = async (enabled: boolean) => {
    try {
      await api.setDryRun(enabled)
      setDryRunErr(null)
      refresh()
    } catch {
      flashError("Couldn't reach server — try again", setDryRunErr, dryRunErrTimer)
    }
  }

  const handlePauseResume = async (pause: boolean) => {
    try {
      if (pause) await api.pauseScheduler()
      else       await api.resumeScheduler()
      setPauseErr(null)
      refresh()
    } catch {
      flashError("Couldn't reach server — try again", setPauseErr, pauseErrTimer)
    }
  }

  // Task #81 — combined "showing last known state" signal: either the most
  // recent /api/state poll failed, the server flagged its response as
  // degraded (e.g. past-jobs auto-inactivated, fallback job id, etc.), or
  // the snapshot is older than STALE_AGE_MS.
  const stateMeta = appState.meta
  const STALE_AGE_MS = 5 * 60 * 1000
  const stale =
    pollFailed ||
    !!stateMeta?.degradedReason ||
    !!stateMeta?.fallbackJobId ||
    (typeof stateMeta?.snapshotAge === 'number' && stateMeta.snapshotAge > STALE_AGE_MS)

  const handleClear = async () => {
    if (clearing) return
    setClearing(true)
    setClearFeedback({ text: 'Clearing…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsClear()
      if (result.success) {
        setClearFeedback({ text: result.detail ?? 'Session cleared. Log in before the next registration run.', cls: 'text-accent-amber' })
        onSessionRefresh?.()
      } else {
        setClearFeedback({ text: result.detail ?? 'Clear failed — try again', cls: 'text-accent-red' })
      }
    } catch {
      setClearFeedback({ text: 'Could not reach server — try again', cls: 'text-accent-red' })
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <AppHeader subtitle="Settings" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} tab={tab} onTabChange={onTabChange} scrolled={scrolled} />
      <ScreenContainer>

        {stale && (
          <StaleStatePill
            ageSeconds={
              typeof stateMeta?.snapshotAge === 'number'
                ? stateMeta.snapshotAge / 1000
                : null
            }
            onRetry={async () => {
              // Task #89 — Settings only depends on /api/state, so a manual
              // retry just re-runs the parent poll.  `refresh` itself is
              // async inside useAppState; we await a microtask wrapper so the
              // pill spinner stays visible until the fetch settles.
              await Promise.resolve(refresh())
            }}
          />
        )}

        {/* Scheduler */}
        <SectionHeader title="Scheduler" />
        <Card padding="none">
          <ToggleRow
            label="Pause Scheduler"
            detail="Stop automatic registration attempts"
            value={appState.schedulerPaused}
            onChange={pause => handlePauseResume(pause)}
          />
          {pauseErr && (
            <p data-testid="pause-error" className="text-[12px] text-accent-red px-4 pb-2 -mt-1">{pauseErr}</p>
          )}
          <div className="h-px bg-divider mx-4" />
          <ToggleRow
            label="Simulation Mode"
            detail="Rehearse without actually registering"
            value={appState.dryRun}
            onChange={handleDryRun}
          />
          {dryRunErr && (
            <p data-testid="dryrun-error" className="text-[12px] text-accent-red px-4 pb-2 -mt-1">{dryRunErr}</p>
          )}
        </Card>

        {/* Status */}
        <SectionHeader title="Status" />
        <Card padding="none">
          <DetailRow label="Scheduler" value={appState.schedulerPaused ? 'Paused' : 'Active'} />
          <DetailRow label="Mode" value={appState.dryRun ? 'Simulation' : 'Live'} />
          <DetailRow label="Classes" value={`${appState.jobs.length} configured`} last />
        </Card>

        {/* Session */}
        <SectionHeader title="Session" />
        <Card>
          <p className="text-[14px] text-text-secondary leading-snug mb-4">
            Reset all saved auth state. Use this if sign-in is stuck or credentials are out of sync.
            You will need to log in again before the next registration run.
          </p>
          <button
            onClick={handleClear}
            disabled={clearing}
            className={`
              w-full py-3 rounded-xl text-[15px] font-semibold transition-opacity
              ${clearing
                ? 'bg-surface text-text-muted opacity-60 cursor-not-allowed'
                : 'bg-[#fff3cd] text-[#92600a] active:opacity-70'}
            `}
          >
            {clearing ? 'Clearing…' : 'Clear session'}
          </button>
          {clearFeedback && !clearing && (
            <p className={`text-[13px] mt-3 text-center leading-snug ${clearFeedback.cls}`}>
              {clearFeedback.text}
            </p>
          )}
        </Card>

      </ScreenContainer>
    </>
  )
}
