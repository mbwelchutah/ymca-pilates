import { useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import type { AppState, Job, Phase } from '../types'
import { api } from '../lib/api'

interface PlanScreenProps {
  appState: AppState
  selectedJobId: number | null
  onSelectJob: (id: number) => void
  loading: boolean
  refresh: () => void
}

const DAY_NAMES: Record<number, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
}

const PHASE_DOT: Record<Phase, 'gray' | 'amber' | 'blue' | 'red' | 'green'> = {
  too_early: 'gray',
  warmup:    'amber',
  sniper:    'blue',
  late:      'red',
  unknown:   'gray',
}

const PHASE_LABEL: Record<Phase, string> = {
  too_early: 'Waiting',
  warmup:    'Opening Soon',
  sniper:    'Booking Now',
  late:      'Window Closed',
  unknown:   'Waiting',
}

function formatOpens(ms: number): string {
  const now = Date.now()
  if (ms < now) return 'Opened'
  return `Opens ${new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })}`
}

interface JobCardProps {
  job: Job
  isWatching: boolean
  onToggle: (e: React.MouseEvent) => void
  onDelete: () => void
  onSelect: () => void
}

function JobCard({ job, isWatching, onToggle, onDelete, onSelect }: JobCardProps) {
  const [confirming, setConfirming] = useState(false)
  const dayName = DAY_NAMES[job.day_of_week as unknown as number] ?? job.day_of_week
  const phase = (job.phase ?? 'unknown') as Phase

  return (
    <Card padding="none" className={`overflow-hidden ${!job.is_active ? 'opacity-50' : ''}`}>
      {/* Watching stripe */}
      {isWatching && (
        <div className="h-0.5 bg-accent-blue w-full" />
      )}

      {/* Main tappable body — selects the job */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === 'Enter' && onSelect()}
        className="px-4 py-3.5 flex items-start gap-3 cursor-pointer active:bg-divider transition-colors"
      >
        <div className="flex-1 min-w-0">
          {/* Class name row */}
          <div className="flex items-center gap-2">
            <StatusDot color={job.is_active ? 'green' : 'gray'} size="sm" />
            <span className="text-[16px] font-semibold text-text-primary tracking-tight leading-tight">
              {job.class_title}
            </span>
            {isWatching && (
              <span className="ml-auto text-[11px] font-semibold text-accent-blue bg-accent-blue/10 px-2 py-0.5 rounded-pill flex-shrink-0">
                Watching
              </span>
            )}
          </div>

          {/* Day + time + instructor */}
          <p className="text-[13px] text-text-secondary mt-0.5">
            {dayName} at {job.class_time}
            {job.instructor ? ` · ${job.instructor}` : ''}
          </p>

          {/* Phase + booking window */}
          {job.is_active && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <StatusDot color={PHASE_DOT[phase]} size="sm" />
              <span className="text-[12px] text-text-secondary">
                {PHASE_LABEL[phase]}
                {job.bookingOpenMs != null
                  ? ` · ${formatOpens(job.bookingOpenMs)}`
                  : ''}
              </span>
            </div>
          )}
        </div>

        {/* Active toggle — stop propagation so it doesn't also select the job */}
        <button
          onClick={e => { e.stopPropagation(); onToggle(e) }}
          className={`
            mt-0.5 px-3 py-1.5 rounded-pill text-[12px] font-semibold flex-shrink-0
            transition-colors active:opacity-70
            ${job.is_active
              ? 'bg-accent-green/10 text-accent-green'
              : 'bg-divider text-text-secondary'}
          `}
        >
          {job.is_active ? 'On' : 'Off'}
        </button>
      </div>

      <div className="h-px bg-divider mx-4" />

      {/* Footer: delete */}
      <div className="px-4 py-2.5 flex items-center justify-end">
        {confirming ? (
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-text-secondary">Remove this class?</span>
            <button
              onClick={() => setConfirming(false)}
              className="text-[13px] font-semibold text-text-secondary"
            >
              Cancel
            </button>
            <button
              onClick={onDelete}
              className="text-[13px] font-semibold text-accent-red"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="text-[13px] text-text-muted active:opacity-70"
          >
            Remove
          </button>
        )}
      </div>
    </Card>
  )
}

function AddJobForm({ onDone }: { onDone: () => void }) {
  const [classTitle, setClassTitle] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(2)
  const [classTime, setClassTime] = useState('')
  const [instructor, setInstructor] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!classTitle.trim() || !classTime.trim()) {
      setErr('Class name and time are required')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await api.addJob({
        class_title: classTitle.trim(),
        day_of_week: dayOfWeek as unknown as string,
        class_time: classTime.trim(),
        instructor: instructor.trim() || null,
        target_date: null,
        is_active: true,
      })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn\'t add the class')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full bg-surface rounded-xl px-4 py-3 text-[15px] text-text-primary outline-none border border-transparent focus:border-accent-blue/40 transition-colors'
  const labelClass = 'text-[12px] font-semibold text-text-secondary uppercase tracking-wide mb-1 block'

  return (
    <Card padding="md">
      <h3 className="text-[17px] font-bold text-text-primary tracking-tight mb-4">Add a Class</h3>
      <div className="flex flex-col gap-3">
        <div>
          <label className={labelClass}>Class Name</label>
          <input className={inputClass} placeholder="Core Pilates" value={classTitle} onChange={e => setClassTitle(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Day</label>
          <select className={inputClass} value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))}>
            {Object.entries(DAY_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass}>Time</label>
          <input className={inputClass} placeholder="4:20 PM" value={classTime} onChange={e => setClassTime(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Instructor (optional)</label>
          <input className={inputClass} placeholder="Gretl" value={instructor} onChange={e => setInstructor(e.target.value)} />
        </div>
        {err && <p className="text-[13px] text-accent-red">{err}</p>}
        <div className="flex gap-2 mt-1">
          <SecondaryButton fullWidth onClick={onDone}>Cancel</SecondaryButton>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 bg-accent-blue text-white font-semibold text-[15px] rounded-btn px-5 py-4 active:opacity-70 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Add Class'}
          </button>
        </div>
      </div>
    </Card>
  )
}

export function PlanScreen({ appState, selectedJobId, onSelectJob, loading, refresh }: PlanScreenProps) {
  const [showAdd, setShowAdd] = useState(false)

  const handleToggle = async (job: Job) => {
    try {
      await api.toggleActive(job.id)
      refresh()
    } catch { /* ignored */ }
  }

  const handleDelete = async (job: Job) => {
    try {
      await api.deleteJob(job.id)
      refresh()
    } catch { /* ignored */ }
  }

  return (
    <>
      <AppHeader
        subtitle="Schedule"
        action={showAdd ? undefined : { label: 'Add', onClick: () => setShowAdd(true) }}
      />
      <ScreenContainer>
        {showAdd && (
          <AddJobForm onDone={() => { setShowAdd(false); refresh() }} />
        )}

        <SectionHeader title={`${appState.jobs.length} Class${appState.jobs.length !== 1 ? 'es' : ''}`} />

        {loading ? (
          <Card className="flex items-center justify-center h-24">
            <span className="text-text-secondary text-[15px]">Loading…</span>
          </Card>
        ) : appState.jobs.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 py-10">
            <p className="text-[17px] font-semibold text-text-primary">No classes yet</p>
            <p className="text-[14px] text-text-secondary text-center px-6">
              Add a class to start automating your registrations
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-2 text-accent-blue text-[15px] font-semibold"
            >
              Add Class
            </button>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {appState.jobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                isWatching={job.id === selectedJobId}
                onToggle={() => handleToggle(job)}
                onDelete={() => handleDelete(job)}
                onSelect={() => onSelectJob(job.id)}
              />
            ))}
          </div>
        )}

        {/* Hint when multiple classes exist */}
        {appState.jobs.length > 1 && (
          <p className="text-center text-[12px] text-text-muted px-4">
            Tap a class to track it on the Now tab
          </p>
        )}
      </ScreenContainer>
    </>
  )
}
