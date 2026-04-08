import { useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import type { AppState, AuthStatusEnum } from '../types'
import { api } from '../lib/api'

interface SettingsScreenProps {
  appState: AppState
  refresh: () => void
  onAccount?: () => void
  accountAttention?: boolean
  authStatus?: AuthStatusEnum | null
}

export function SettingsScreen({ appState, refresh, onAccount, accountAttention, authStatus }: SettingsScreenProps) {
  const [clearing,     setClearing]     = useState(false)
  const [clearFeedback, setClearFeedback] = useState<{ text: string; cls: string } | null>(null)

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

  const handleClear = async () => {
    if (clearing) return
    setClearing(true)
    setClearFeedback({ text: 'Clearing…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsClear()
      if (result.success) {
        setClearFeedback({ text: result.detail ?? 'Session cleared. Log in before the next booking run.', cls: 'text-accent-amber' })
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
      <AppHeader subtitle="Settings" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} />
      <ScreenContainer>

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

        {/* Session */}
        <SectionHeader title="Session" />
        <Card>
          <p className="text-[14px] text-text-secondary leading-snug mb-4">
            Reset all saved auth state. Use this if sign-in is stuck or credentials are out of sync.
            You will need to log in again before the next booking run.
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
