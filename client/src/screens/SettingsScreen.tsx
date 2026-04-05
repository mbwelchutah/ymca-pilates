import { useState, useEffect, useRef, useCallback } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import type { AppState, SessionStatus } from '../types'
import { api } from '../lib/api'

interface SettingsScreenProps {
  appState: AppState
  refresh: () => void
}

function daxkoLabel(s: SessionStatus['daxko']): { text: string; cls: string } {
  switch (s) {
    case 'DAXKO_READY':       return { text: 'Ready',         cls: 'text-accent-green' }
    case 'AUTH_NEEDS_LOGIN':  return { text: 'Login required', cls: 'text-accent-red'  }
    default:                  return { text: 'Unknown',        cls: 'text-text-secondary' }
  }
}

function familyworksLabel(s: SessionStatus['familyworks']): { text: string; cls: string } {
  switch (s) {
    case 'FAMILYWORKS_READY':            return { text: 'Ready',   cls: 'text-accent-green' }
    case 'FAMILYWORKS_SESSION_MISSING':  return { text: 'Expired', cls: 'text-accent-amber' }
    default:                             return { text: 'Unknown', cls: 'text-text-secondary' }
  }
}

function formatVerified(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    const d = new Date(iso)
    const datePart = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d)
    const timePart = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
    return `${datePart} at ${timePart}`
  } catch {
    return '—'
  }
}

type ActionState = 'idle' | 'running' | 'done' | 'error'

interface Feedback { text: string; cls: string }

export function SettingsScreen({ appState, refresh }: SettingsScreenProps) {
  const [sessionStatus,  setSessionStatus]  = useState<SessionStatus | null>(null)
  const [loginState,     setLoginState]     = useState<ActionState>('idle')
  const [refreshState,   setRefreshState]   = useState<ActionState>('idle')
  const [clearState,     setClearState]     = useState<ActionState>('idle')
  const [feedback,       setFeedback]       = useState<Feedback | null>(null)
  const [lockWaiting,    setLockWaiting]    = useState(false)

  const lockTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  // After a timeout, suppress automatic re-entry until the user takes an action
  const suppressAutoLockRef = useRef(false)

  const stopLockTimers = useCallback(() => {
    if (lockTimerRef.current) { clearTimeout(lockTimerRef.current);  lockTimerRef.current = null }
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
  }, [])

  const exitLockWait = useCallback(() => {
    stopLockTimers()
    setLockWaiting(false)
    setFeedback(null)
  }, [stopLockTimers])

  // Separate timeout exit: keeps buttons enabled and shows an explanatory message
  // rather than silently clearing feedback. Also suppresses auto-relock so the user
  // can act even while the server lock may still be set.
  const timeoutExit = useCallback(() => {
    suppressAutoLockRef.current = true
    stopLockTimers()
    setLockWaiting(false)
    setFeedback({
      text: 'Previous booking finished or timed out — you can try again',
      cls:  'text-accent-amber',
    })
  }, [stopLockTimers])

  const fetchSessionStatus = useCallback(() => {
    api.getSessionStatus()
      .then(s => setSessionStatus(s))
      .catch(() => setSessionStatus(null))
  }, [])

  useEffect(() => { fetchSessionStatus() }, [fetchSessionStatus])

  useEffect(() => () => stopLockTimers(), [stopLockTimers])

  const enterLockWait = useCallback(() => {
    suppressAutoLockRef.current = false   // clear any prior timeout suppression
    setLockWaiting(true)
    setLoginState('idle')
    setRefreshState('idle')
    setClearState('idle')
    setFeedback({
      text: 'Booking in progress — settings will re-enable automatically',
      cls:  'text-accent-amber',
    })
    stopLockTimers()
    lockTimerRef.current = setTimeout(timeoutExit, 90_000)
    pollTimerRef.current = setInterval(() => {
      api.getSessionStatus()
        .then(s => {
          setSessionStatus(s)
          if (!s.locked) exitLockWait()
        })
        .catch(() => { /* keep waiting */ })
    }, 10_000)
  }, [stopLockTimers, exitLockWait, timeoutExit])

  // Auto-enter lock-wait if the page is opened while a booking job is running,
  // unless a previous timeout has already released the buttons.
  useEffect(() => {
    if (sessionStatus?.locked && !lockWaiting && !suppressAutoLockRef.current) {
      enterLockWait()
    }
  }, [sessionStatus, lockWaiting, enterLockWait])

  const handleLogin = async () => {
    if (lockWaiting || loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setLoginState('running')
    setFeedback({ text: 'Logging in — this takes about 30 seconds…', cls: 'text-text-secondary' })
    let gotLocked = false
    try {
      const result = await api.settingsLogin()
      if (result.locked) {
        gotLocked = true
        enterLockWait()
      } else if (result.success) {
        setLoginState('done')
        setFeedback({ text: result.detail ?? 'Login complete', cls: 'text-accent-green' })
      } else {
        setLoginState('error')
        setFeedback({ text: result.detail ?? 'Login failed', cls: 'text-accent-red' })
      }
    } catch (e: unknown) {
      setLoginState('error')
      setFeedback({ text: e instanceof Error ? e.message : 'Login failed unexpectedly', cls: 'text-accent-red' })
    } finally {
      if (!gotLocked) fetchSessionStatus()
    }
  }

  const handleRefresh = async () => {
    if (lockWaiting || loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setRefreshState('running')
    setFeedback({ text: 'Checking credentials — this takes about 15 seconds…', cls: 'text-text-secondary' })
    let gotLocked = false
    try {
      const result = await api.settingsRefresh()
      if (result.locked) {
        gotLocked = true
        enterLockWait()
      } else if (result.success) {
        setRefreshState('done')
        setFeedback({ text: result.detail ?? 'Session refreshed', cls: 'text-accent-green' })
      } else {
        setRefreshState('error')
        setFeedback({ text: result.detail ?? 'Refresh failed', cls: 'text-accent-red' })
      }
    } catch (e: unknown) {
      setRefreshState('error')
      setFeedback({ text: e instanceof Error ? e.message : 'Refresh failed unexpectedly', cls: 'text-accent-red' })
    } finally {
      if (!gotLocked) fetchSessionStatus()
    }
  }

  const handleClear = async () => {
    if (lockWaiting || loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setClearState('running')
    setFeedback({ text: 'Clearing session data…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsClear()
      if (result.success) {
        setClearState('done')
        setFeedback({ text: result.detail ?? 'Session cleared', cls: 'text-accent-green' })
        setSessionStatus({
          valid:        false,
          checkedAt:    null,
          detail:       result.detail ?? null,
          screenshot:   null,
          daxko:        result.daxko       ?? 'AUTH_UNKNOWN',
          familyworks:  result.familyworks ?? 'AUTH_UNKNOWN',
          overall:      result.overall     ?? 'AUTH_UNKNOWN',
          lastVerified: result.lastVerified ?? null,
        })
      } else {
        setClearState('error')
        setFeedback({ text: result.detail ?? 'Clear failed', cls: 'text-accent-red' })
      }
    } catch (e: unknown) {
      setClearState('error')
      setFeedback({ text: e instanceof Error ? e.message : 'Clear failed unexpectedly', cls: 'text-accent-red' })
    }
  }

  const handleDryRun     = async (enabled: boolean) => {
    try { await api.setDryRun(enabled); refresh() } catch { /* ignored */ }
  }
  const handlePauseResume = async (pause: boolean) => {
    try {
      if (pause) await api.pauseScheduler()
      else       await api.resumeScheduler()
      refresh()
    } catch { /* ignored */ }
  }

  const daxko       = sessionStatus ? daxkoLabel(sessionStatus.daxko)            : { text: '—', cls: 'text-text-secondary' }
  const familyworks = sessionStatus ? familyworksLabel(sessionStatus.familyworks) : { text: '—', cls: 'text-text-secondary' }
  const verified    = sessionStatus ? formatVerified(sessionStatus.lastVerified)  : '—'

  const anyBusy     = lockWaiting || loginState === 'running' || refreshState === 'running' || clearState === 'running'
  const loginBusy   = loginState  === 'running'
  const refreshBusy = refreshState === 'running'
  const clearBusy   = clearState  === 'running'

  return (
    <>
      <AppHeader subtitle="Settings" />
      <ScreenContainer>

        {/* Account & Session */}
        <SectionHeader title="Account & Session" />
        <Card padding="none">
          <div className="flex items-center justify-between py-3 px-4">
            <span className="text-[14px] text-text-secondary">Account</span>
            <span className={`text-[14px] font-medium ${daxko.cls}`}>{daxko.text}</span>
          </div>
          <div className="h-px bg-divider mx-4" />
          <div className="flex items-center justify-between py-3 px-4">
            <span className="text-[14px] text-text-secondary">Schedule access</span>
            <span className={`text-[14px] font-medium ${familyworks.cls}`}>{familyworks.text}</span>
          </div>
          <div className="h-px bg-divider mx-4" />
          <DetailRow label="Last verified" value={verified} last />
        </Card>

        <Card padding="sm" className="flex flex-col gap-2">
          <button
            onClick={handleLogin}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-accent-blue text-white text-[14px] font-semibold transition-opacity duration-150 ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {loginBusy ? 'Logging in…' : lockWaiting ? 'Waiting…' : 'Log in now'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-[#1c1c1e] text-[14px] font-semibold transition-opacity duration-150 ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {refreshBusy ? 'Checking…' : 'Refresh session'}
          </button>
          <button
            onClick={handleClear}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-accent-red text-[14px] font-semibold transition-opacity duration-150 ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {clearBusy ? 'Clearing…' : 'Clear session'}
          </button>

          {lockWaiting && feedback ? (
            <div className="flex items-center gap-1.5 px-1">
              <svg
                className="animate-spin h-3 w-3 text-accent-amber shrink-0"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle
                  cx="6" cy="6" r="4.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeDasharray="12 6"
                />
              </svg>
              <p className="text-[12px] text-accent-amber">{feedback.text}</p>
            </div>
          ) : feedback ? (
            <p className={`text-[12px] px-1 ${feedback.cls}`}>{feedback.text}</p>
          ) : null}
        </Card>

        {/* Scheduler */}
        <SectionHeader title="Scheduler" />
        <Card padding="none">
          <ToggleRow
            label="Pause Scheduler"
            detail="Stop automatic booking attempts"
            value={appState.schedulerPaused}
            onChange={pause => handlePauseResume(pause)}
          />
          <div className="h-px bg-divider mx-4" />
          <ToggleRow
            label="Simulation Mode"
            detail="Rehearse without actually registering"
            value={appState.dryRun}
            onChange={handleDryRun}
          />
        </Card>

        {/* Status */}
        <SectionHeader title="Status" />
        <Card padding="none">
          <DetailRow label="Scheduler" value={appState.schedulerPaused ? 'Paused' : 'Active'} />
          <DetailRow label="Mode" value={appState.dryRun ? 'Simulation' : 'Live'} />
          <DetailRow label="Classes" value={`${appState.jobs.length} configured`} last />
        </Card>

      </ScreenContainer>
    </>
  )
}
