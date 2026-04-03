import { useState, useEffect } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { PrimaryButton } from '../components/ui/PrimaryButton'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import { DetailRow } from '../components/ui/DetailRow'
import type { AppState, Job, Phase } from '../types'
import { api } from '../lib/api'

interface NowScreenProps {
  appState: AppState
  selectedJobId: number | null
  loading: boolean
  error: string | null
  refresh: () => void
}

function useCountdown(targetMs: number | null) {
  const [display, setDisplay] = useState('')
  useEffect(() => {
    if (!targetMs) { setDisplay(''); return }
    const tick = () => {
      const diff = targetMs - Date.now()
      if (diff <= 0) { setDisplay('Now'); return }
      const d = Math.floor(diff / 86400000)
      const h = Math.floor((diff % 86400000) / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      if (d > 0)      setDisplay(`${d}d ${h}h ${m}m`)
      else if (h > 0) setDisplay(`${h}h ${m}m ${s}s`)
      else            setDisplay(`${m}m ${s}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [targetMs])
  return display
}

const PHASE_CONFIG: Record<Phase, { label: string; dotColor: 'gray' | 'amber' | 'blue' | 'green' | 'red'; headerSubtitle: string }> = {
  too_early:  { label: 'Monitoring',    dotColor: 'gray',  headerSubtitle: 'Monitoring' },
  warmup:     { label: 'Opening Soon',  dotColor: 'amber', headerSubtitle: 'Warming Up' },
  sniper:     { label: 'Booking Now',   dotColor: 'blue',  headerSubtitle: 'Booking Now' },
  late:       { label: 'Window Closed', dotColor: 'red',   headerSubtitle: 'Window Closed' },
  unknown:    { label: 'Monitoring',    dotColor: 'gray',  headerSubtitle: 'Monitoring' },
}

const RESULT_CONFIG: Record<string, { label: string; dotColor: 'gray' | 'green' | 'amber' | 'red' | 'blue' }> = {
  booked:              { label: 'Booked',          dotColor: 'green' },
  dry_run:             { label: 'Booked (Dry Run)', dotColor: 'blue'  },
  found_not_open_yet:  { label: 'Not Open Yet',    dotColor: 'amber' },
  not_found:           { label: 'Class Not Found', dotColor: 'red'   },
  error:               { label: 'Error',            dotColor: 'red'   },
  skipped:             { label: 'Skipped',          dotColor: 'gray'  },
}

function formatDayTime(job: Job) {
  const days: Record<number, string> = { 0:'Sunday',1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',5:'Friday',6:'Saturday' }
  const dayName = days[job.day_of_week as unknown as number] ?? job.day_of_week
  return `${dayName} at ${job.class_time}${job.instructor ? ` with ${job.instructor}` : ''}`
}

const STEPS = ['Waiting', 'Opening Soon', 'Booking', 'Done']
const PHASE_STEP: Record<Phase, number> = { too_early: 0, warmup: 1, sniper: 2, late: 3, unknown: 0 }

export function NowScreen({ appState, selectedJobId, loading, error, refresh }: NowScreenProps) {
  const job = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null
  // Prefer the selected job's own enriched phase/window; fall back to appState top-level.
  const phase: Phase = (job?.phase ?? appState.phase) as Phase
  const cfg = PHASE_CONFIG[phase]
  const countdown = useCountdown(job?.bookingOpenMs ?? appState.bookingOpenMs ?? null)
  const stepIdx = PHASE_STEP[phase]
  const isBooked = job?.last_result === 'booked' || job?.last_result === 'dry_run'
  const [forceLoading, setForceLoading] = useState(false)
  const [forceMsg, setForceMsg] = useState<string | null>(null)

  const handleForce = async () => {
    if (!job) return
    setForceLoading(true)
    setForceMsg(null)
    try {
      const r = await api.forceRunJob(job.id)
      setForceMsg(r.message)
      refresh()
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setForceLoading(false)
    }
  }

  const handlePauseResume = async () => {
    try {
      if (appState.schedulerPaused) await api.resumeScheduler()
      else await api.pauseScheduler()
      refresh()
    } catch { /* ignored */ }
  }

  if (loading) {
    return (
      <>
        <AppHeader subtitle="Loading…" />
        <ScreenContainer>
          <Card className="flex items-center justify-center h-40">
            <span className="text-text-secondary text-[15px]">Loading…</span>
          </Card>
        </ScreenContainer>
      </>
    )
  }

  if (error) {
    return (
      <>
        <AppHeader subtitle="Error" />
        <ScreenContainer>
          <Card>
            <p className="text-accent-red text-[14px]">{error}</p>
            <button onClick={refresh} className="mt-3 text-accent-blue text-[14px] font-semibold">Retry</button>
          </Card>
        </ScreenContainer>
      </>
    )
  }

  return (
    <>
      <AppHeader
        subtitle={cfg.headerSubtitle + (appState.dryRun ? ' · Dry Run' : ' · Live')}
      />

      <ScreenContainer>
        {/* Hero card */}
        <Card id="now-hero-card" padding="md">
          {/* State row */}
          <div className="flex items-center gap-2 mb-3">
            <StatusDot color={cfg.dotColor} />
            <span className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
              {cfg.label}
            </span>
            {appState.schedulerPaused && (
              <span className="ml-auto text-[12px] font-medium text-accent-amber bg-accent-amber/10 px-2 py-0.5 rounded-pill">
                Paused
              </span>
            )}
          </div>

          {/* Class name */}
          {job ? (
            <>
              <h2 className="text-[28px] font-bold tracking-tighter text-text-primary leading-tight">
                {job.class_title}
              </h2>
              <p className="text-[14px] text-text-secondary mt-1 mb-3">
                {formatDayTime(job)}
              </p>
            </>
          ) : (
            <p className="text-[17px] text-text-secondary mb-3">No job selected</p>
          )}

          {/* Booked success OR countdown */}
          {isBooked ? (
            <div className="bg-accent-green/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="green" />
              <span className="text-[17px] font-semibold text-accent-green">
                {job?.last_result === 'dry_run' ? 'Booked (Dry Run)' : 'Booked'}
              </span>
            </div>
          ) : (
            <div className="bg-surface rounded-xl px-4 py-3 flex items-baseline gap-2">
              <span className="text-[42px] font-bold text-text-primary tabular-nums leading-none tracking-tighter">
                {countdown || '—'}
              </span>
              <span className="text-[14px] text-text-secondary font-medium">until window opens</span>
            </div>
          )}
        </Card>

        {/* Progress steps */}
        <Card id="now-progress-card" padding="md">
          <SectionHeader title="Progress" />
          <div className="flex items-center mt-2 gap-1">
            {STEPS.map((step, i) => {
              const done    = i < stepIdx
              const current = i === stepIdx
              const future  = i > stepIdx
              return (
                <div key={step} className="flex-1 flex flex-col items-center gap-1.5">
                  <div
                    className={`
                      h-1.5 w-full rounded-pill
                      ${done    ? 'bg-accent-green'  : ''}
                      ${current ? 'bg-accent-blue'   : ''}
                      ${future  ? 'bg-divider'        : ''}
                    `}
                  />
                  <span className={`
                    text-[10px] font-medium text-center leading-tight
                    ${done    ? 'text-accent-green'    : ''}
                    ${current ? 'text-accent-blue'     : ''}
                    ${future  ? 'text-text-muted'      : ''}
                  `}>
                    {step}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>

        {/* Action row */}
        <div className="flex gap-2">
          <SecondaryButton
            className="flex-1"
            onClick={handlePauseResume}
          >
            {appState.schedulerPaused ? 'Resume' : 'Pause'}
          </SecondaryButton>
          <PrimaryButton
            className="flex-1"
            onClick={handleForce}
            disabled={!job || forceLoading}
          >
            {forceLoading ? 'Running…' : 'Force Book'}
          </PrimaryButton>
        </div>

        {/* Force run result */}
        {forceMsg && (
          <Card padding="sm">
            <p className="text-[13px] text-text-secondary">{forceMsg}</p>
          </Card>
        )}

        {/* Detail card */}
        {job && (
          <>
            <SectionHeader title="Details" />
            <Card padding="none">
              <DetailRow label="Job" value={`#${job.id}`} />
              <DetailRow label="Status" value={job.last_result ? (RESULT_CONFIG[job.last_result]?.label ?? job.last_result) : 'No runs yet'} />
              <DetailRow label="Opens" value={(job?.bookingOpenMs ?? appState.bookingOpenMs)
                ? new Date((job?.bookingOpenMs ?? appState.bookingOpenMs)!).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : '—'
              } />
              <DetailRow label="Last Run" value={job.last_run_at ? new Date(job.last_run_at).toLocaleString() : '—'} />
              <DetailRow label="Mode" value={appState.dryRun ? 'Dry Run' : 'Live'} last />
            </Card>
          </>
        )}

        {/* Dry run notice */}
        {appState.dryRun && (
          <Card padding="sm" className="border border-accent-amber/30 bg-accent-amber/5">
            <p className="text-[13px] text-accent-amber font-medium">
              Dry Run mode — no real bookings will be made. Switch to Live in Settings.
            </p>
          </Card>
        )}
      </ScreenContainer>
    </>
  )
}
