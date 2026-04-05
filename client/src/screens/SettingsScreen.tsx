import { useState, useEffect } from 'react'
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
    case 'DAXKO_READY':       return { text: 'Ready',      cls: 'text-accent-green' }
    case 'AUTH_NEEDS_LOGIN':  return { text: 'Needs login', cls: 'text-accent-red'  }
    default:                  return { text: 'Unknown',    cls: 'text-text-secondary' }
  }
}

function familyworksLabel(s: SessionStatus['familyworks']): { text: string; cls: string } {
  switch (s) {
    case 'FAMILYWORKS_READY':            return { text: 'Ready',          cls: 'text-accent-green' }
    case 'FAMILYWORKS_SESSION_MISSING':  return { text: 'Session missing', cls: 'text-accent-amber' }
    default:                             return { text: 'Unknown',        cls: 'text-text-secondary' }
  }
}

function overallLabel(s: SessionStatus['overall']): { text: string; cls: string } {
  switch (s) {
    case 'DAXKO_READY':                  return { text: 'All systems ready',  cls: 'text-accent-green' }
    case 'FAMILYWORKS_READY':            return { text: 'All systems ready',  cls: 'text-accent-green' }
    case 'FAMILYWORKS_SESSION_MISSING':  return { text: 'Session missing',    cls: 'text-accent-amber' }
    case 'AUTH_NEEDS_LOGIN':             return { text: 'Login required',     cls: 'text-accent-red'   }
    default:                             return { text: 'Unknown',            cls: 'text-text-secondary' }
  }
}

function formatVerified(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))
  } catch {
    return '—'
  }
}

type ActionState = 'idle' | 'running' | 'done' | 'error'

export function SettingsScreen({ appState, refresh }: SettingsScreenProps) {
  const [sessionStatus,  setSessionStatus]  = useState<SessionStatus | null>(null)
  const [loginState,     setLoginState]     = useState<ActionState>('idle')
  const [loginDetail,    setLoginDetail]    = useState<string>('')
  const [refreshState,   setRefreshState]   = useState<ActionState>('idle')
  const [refreshDetail,  setRefreshDetail]  = useState<string>('')
  const [clearState,     setClearState]     = useState<ActionState>('idle')
  const [clearDetail,    setClearDetail]    = useState<string>('')

  const fetchSessionStatus = () => {
    api.getSessionStatus()
      .then(setSessionStatus)
      .catch(() => setSessionStatus(null))
  }

  useEffect(() => { fetchSessionStatus() }, [])

  const handleLogin = async () => {
    if (loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setLoginState('running')
    setLoginDetail('Logging in — this takes about 30 seconds…')
    try {
      const result = await api.settingsLogin()
      if (result.success) {
        setLoginState('done')
        setLoginDetail(result.detail ?? 'Login complete')
      } else {
        setLoginState('error')
        setLoginDetail(result.detail ?? 'Login failed')
      }
    } catch (e: unknown) {
      setLoginState('error')
      setLoginDetail(e instanceof Error ? e.message : 'Login failed unexpectedly')
    } finally {
      fetchSessionStatus()
    }
  }

  const handleRefresh = async () => {
    if (loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setRefreshState('running')
    setRefreshDetail('Checking credentials — this takes about 15 seconds…')
    try {
      const result = await api.settingsRefresh()
      if (result.success) {
        setRefreshState('done')
        setRefreshDetail(result.detail ?? 'Refresh complete')
      } else {
        setRefreshState('error')
        setRefreshDetail(result.detail ?? 'Refresh failed')
      }
    } catch (e: unknown) {
      setRefreshState('error')
      setRefreshDetail(e instanceof Error ? e.message : 'Refresh failed unexpectedly')
    } finally {
      fetchSessionStatus()
    }
  }

  const handleClear = async () => {
    if (loginState === 'running' || refreshState === 'running' || clearState === 'running') return
    setClearState('running')
    setClearDetail('Clearing session data…')
    try {
      const result = await api.settingsClear()
      if (result.success) {
        setClearState('done')
        setClearDetail(result.detail ?? 'Session cleared')
      } else {
        setClearState('error')
        setClearDetail(result.detail ?? 'Clear failed')
      }
    } catch (e: unknown) {
      setClearState('error')
      setClearDetail(e instanceof Error ? e.message : 'Clear failed unexpectedly')
    } finally {
      fetchSessionStatus()
    }
  }

  const handleDryRun = async (enabled: boolean) => {
    try { await api.setDryRun(enabled); refresh() } catch { /* ignored */ }
  }

  const handlePauseResume = async (pause: boolean) => {
    try {
      if (pause) await api.pauseScheduler()
      else       await api.resumeScheduler()
      refresh()
    } catch { /* ignored */ }
  }

  const daxko      = sessionStatus ? daxkoLabel(sessionStatus.daxko)           : { text: '—', cls: 'text-text-secondary' }
  const familyworks= sessionStatus ? familyworksLabel(sessionStatus.familyworks): { text: '—', cls: 'text-text-secondary' }
  const overall    = sessionStatus ? overallLabel(sessionStatus.overall)        : { text: '—', cls: 'text-text-secondary' }
  const verified   = sessionStatus ? formatVerified(sessionStatus.lastVerified) : '—'

  const anyBusy   = loginState === 'running' || refreshState === 'running' || clearState === 'running'
  const loginBusy = loginState === 'running'
  const loginFeedbackCls =
    loginState === 'done'    ? 'text-accent-green' :
    loginState === 'error'   ? 'text-accent-red'   :
    loginState === 'running' ? 'text-text-secondary' : ''

  const refreshBusy = refreshState === 'running'
  const refreshFeedbackCls =
    refreshState === 'done'    ? 'text-accent-green' :
    refreshState === 'error'   ? 'text-accent-red'   :
    refreshState === 'running' ? 'text-text-secondary' : ''

  const clearBusy = clearState === 'running'
  const clearFeedbackCls =
    clearState === 'done'    ? 'text-accent-green' :
    clearState === 'error'   ? 'text-accent-red'   :
    clearState === 'running' ? 'text-text-secondary' : ''

  return (
    <>
      <AppHeader subtitle="Settings" />
      <ScreenContainer>

        {/* Account & Session */}
        <SectionHeader title="Account & Session" />
        <Card padding="none">
          <div className="flex items-center justify-between py-3 px-4">
            <span className="text-[14px] text-text-secondary">Daxko login</span>
            <span className={`text-[14px] font-medium ${daxko.cls}`}>{daxko.text}</span>
          </div>
          <div className="h-px bg-divider mx-4" />
          <div className="flex items-center justify-between py-3 px-4">
            <span className="text-[14px] text-text-secondary">FamilyWorks session</span>
            <span className={`text-[14px] font-medium ${familyworks.cls}`}>{familyworks.text}</span>
          </div>
          <div className="h-px bg-divider mx-4" />
          <DetailRow label="Last verified" value={verified} />
          <div className="flex items-center justify-between py-3 px-4">
            <span className="text-[14px] text-text-secondary">Overall status</span>
            <span className={`text-[14px] font-medium ${overall.cls}`}>{overall.text}</span>
          </div>
        </Card>
        <Card padding="sm" className="flex flex-col gap-2">
          <button
            onClick={handleLogin}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-accent-blue text-white text-[14px] font-semibold transition-opacity ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {loginBusy ? 'Logging in…' : 'Log in now'}
          </button>
          {loginDetail ? (
            <p className={`text-[12px] px-1 ${loginFeedbackCls}`}>{loginDetail}</p>
          ) : null}
          <button
            onClick={handleRefresh}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-[#1c1c1e] text-[14px] font-semibold transition-opacity ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {refreshBusy ? 'Checking…' : 'Refresh session'}
          </button>
          {refreshDetail ? (
            <p className={`text-[12px] px-1 ${refreshFeedbackCls}`}>{refreshDetail}</p>
          ) : null}
          <button
            onClick={handleClear}
            disabled={anyBusy}
            className={`w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-accent-red text-[14px] font-semibold transition-opacity ${anyBusy ? 'opacity-50 cursor-not-allowed' : 'opacity-100'}`}
          >
            {clearBusy ? 'Clearing…' : 'Clear session'}
          </button>
          {clearDetail ? (
            <p className={`text-[12px] px-1 ${clearFeedbackCls}`}>{clearDetail}</p>
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
