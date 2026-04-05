import { useState, useEffect } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import type { AppState } from '../types'
import { api } from '../lib/api'

interface SettingsScreenProps {
  appState: AppState
  refresh: () => void
}

type SessionStatus = Awaited<ReturnType<typeof api.getSessionStatus>>

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
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1)   return 'Just now'
    if (diffMin < 60)  return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24)    return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    return `${diffD}d ago`
  } catch {
    return '—'
  }
}

export function SettingsScreen({ appState, refresh }: SettingsScreenProps) {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null)

  useEffect(() => {
    api.getSessionStatus()
      .then(setSessionStatus)
      .catch(() => setSessionStatus(null))
  }, [])

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
            disabled
            className="w-full py-2.5 px-4 rounded-lg bg-accent-blue text-white text-[14px] font-semibold opacity-50 cursor-not-allowed"
          >
            Log in now
          </button>
          <button
            disabled
            className="w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-[#1c1c1e] text-[14px] font-semibold opacity-50 cursor-not-allowed"
          >
            Refresh session
          </button>
          <button
            disabled
            className="w-full py-2.5 px-4 rounded-lg bg-[#f2f2f7] text-accent-red text-[14px] font-semibold opacity-50 cursor-not-allowed"
          >
            Clear session
          </button>
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
