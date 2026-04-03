import { useEffect, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import type { AppState } from '../types'
import { api } from '../lib/api'

interface SettingsScreenProps {
  appState: AppState
  selectedJobId: number | null
  refresh: () => void
}

function ToggleRow({ label, detail, value, onChange }: {
  label: string
  detail?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex-1 mr-4">
        <p className="text-[15px] text-text-primary font-medium">{label}</p>
        {detail && <p className="text-[12px] text-text-secondary mt-0.5">{detail}</p>}
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`
          relative inline-flex items-center h-7 w-12 rounded-pill transition-colors flex-shrink-0
          ${value ? 'bg-accent-green' : 'bg-[#e5e5ea]'}
        `}
      >
        <span
          className={`
            absolute h-6 w-6 bg-white rounded-full shadow-sm
            transition-transform duration-200
            ${value ? 'translate-x-[calc(100%-4px)]' : 'translate-x-[2px]'}
          `}
        />
      </button>
    </div>
  )
}

function ActionRow({ label, detail, onClick, loading, disabled }: {
  label: string
  detail?: string
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}) {
  return (
    <button
      disabled={loading || disabled}
      onClick={onClick}
      className={`
        flex items-center justify-between w-full px-4 py-3.5 text-left
        transition-opacity ${disabled ? 'opacity-40' : 'active:opacity-60'}
      `}
    >
      <div className="flex-1 mr-4">
        <p className={`text-[15px] font-medium ${disabled ? 'text-text-secondary' : 'text-accent-blue'}`}>
          {loading ? 'Running…' : label}
        </p>
        {detail && <p className="text-[12px] text-text-secondary mt-0.5">{detail}</p>}
      </div>
      <svg width="8" height="13" viewBox="0 0 8 13" fill="none" className="text-text-muted flex-shrink-0">
        <path d="M1 1l6 5.5L1 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

const fmt = (ms: number) =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function SettingsScreen({ appState, selectedJobId, refresh }: SettingsScreenProps) {
  const selectedJob = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null

  const [forceLoading, setForceLoading] = useState(false)
  const [forceMsg, setForceMsg] = useState<string | null>(null)
  const [runOnceLoading, setRunOnceLoading] = useState(false)
  const [runOnceMsg, setRunOnceMsg] = useState<string | null>(null)
  const [failures, setFailures] = useState<Record<string, number>>({})

  useEffect(() => {
    api.getFailures().then(d => setFailures(d.summary)).catch(() => {})
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

  const handleForce = async () => {
    if (!selectedJob) return
    setForceLoading(true)
    setForceMsg(null)
    try {
      const r = await api.forceRunJob(selectedJob.id)
      setForceMsg(r.message)
      refresh()
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setForceLoading(false)
    }
  }

  const handleRunOnce = async () => {
    setRunOnceLoading(true)
    setRunOnceMsg(null)
    try {
      const r = await api.runSchedulerOnce()
      setRunOnceMsg(r.message)
      refresh()
    } catch (e) {
      setRunOnceMsg(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRunOnceLoading(false)
    }
  }

  const bookingOpenMs = selectedJob?.bookingOpenMs ?? appState.bookingOpenMs
  const warmupMs = bookingOpenMs ? bookingOpenMs - 10 * 60 * 1000 : null
  const failureEntries = Object.entries(failures)

  return (
    <>
      <AppHeader subtitle="Settings" />
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
            label="Dry Run Mode"
            detail="Simulate bookings without registering"
            value={appState.dryRun}
            onChange={handleDryRun}
          />
        </Card>

        {/* Status */}
        <SectionHeader title="Status" />
        <Card padding="none">
          <DetailRow label="Scheduler" value={appState.schedulerPaused ? 'Paused' : 'Active'} />
          <DetailRow label="Mode" value={appState.dryRun ? 'Dry Run' : 'Live'} />
          <DetailRow label="Jobs" value={`${appState.jobs.length} configured`} last />
        </Card>

        {/* Booking Window — live from selected job */}
        {bookingOpenMs && (
          <>
            <SectionHeader title="Booking Window" />
            <Card padding="none">
              <DetailRow label="Job" value={selectedJob ? `#${selectedJob.id} — ${selectedJob.name}` : '—'} />
              <DetailRow label="Opens" value={fmt(bookingOpenMs)} />
              <DetailRow label="Warmup" value={warmupMs ? fmt(warmupMs) : '—'} last />
            </Card>
          </>
        )}

        {/* Developer Actions */}
        <SectionHeader title="Developer Actions" />
        <Card padding="none">
          <ActionRow
            label={selectedJob ? `Force Book — ${selectedJob.name}` : 'Force Book'}
            detail={selectedJob ? `Job #${selectedJob.id} · bypasses cooldown` : 'Select a job in Plan first'}
            onClick={handleForce}
            loading={forceLoading}
            disabled={!selectedJob}
          />
          <div className="h-px bg-divider mx-4" />
          <ActionRow
            label="Run Scheduler Once"
            detail="Trigger a single scheduler tick now"
            onClick={handleRunOnce}
            loading={runOnceLoading}
          />
        </Card>

        {/* Action result messages */}
        {(forceMsg || runOnceMsg) && (
          <Card padding="sm">
            {forceMsg    && <p className="text-[13px] text-text-secondary">{forceMsg}</p>}
            {runOnceMsg  && <p className={`text-[13px] text-text-secondary ${forceMsg ? 'mt-2' : ''}`}>{runOnceMsg}</p>}
          </Card>
        )}

        {/* Failure Log */}
        <SectionHeader title="Failure Log" />
        <Card padding="none">
          {failureEntries.length === 0 ? (
            <DetailRow label="Status" value="No failures recorded" last />
          ) : (
            failureEntries.map(([reason, count], i) => (
              <DetailRow
                key={reason}
                label={reason}
                value={`${count}×`}
                last={i === failureEntries.length - 1}
              />
            ))
          )}
        </Card>

      </ScreenContainer>
    </>
  )
}
