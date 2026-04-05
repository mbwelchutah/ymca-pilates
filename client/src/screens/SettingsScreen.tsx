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

export function SettingsScreen({ appState, refresh }: SettingsScreenProps) {
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

  return (
    <>
      <AppHeader subtitle="Settings" />
      <ScreenContainer>

        {/* Account & Session */}
        <SectionHeader title="Account & Session" />
        <Card padding="none">
          <DetailRow label="Daxko login" value="Unknown" />
          <DetailRow label="FamilyWorks session" value="Unknown" />
          <DetailRow label="Last verified" value="—" />
          <DetailRow label="Overall status" value="Unknown" last />
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
