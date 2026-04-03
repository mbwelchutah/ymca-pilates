import { useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import type { AppState, Job } from '../types'
import { api } from '../lib/api'

interface PlanScreenProps {
  appState: AppState
  loading: boolean
  refresh: () => void
}

const DAY_NAMES: Record<number, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
}

function JobCard({ job, onToggle, onDelete }: { job: Job; onToggle: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const dayName = DAY_NAMES[job.day_of_week as unknown as number] ?? job.day_of_week

  return (
    <Card padding="none" className={!job.is_active ? 'opacity-50' : ''}>
      <div className="px-4 py-3.5 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot color={job.is_active ? 'green' : 'gray'} size="sm" />
            <span className="text-[16px] font-semibold text-text-primary tracking-tight">
              {job.class_title}
            </span>
          </div>
          <p className="text-[13px] text-text-secondary mt-0.5">
            {dayName} at {job.class_time}
            {job.instructor ? ` · ${job.instructor}` : ''}
          </p>
          {job.last_result && (
            <p className="text-[11px] text-text-muted mt-1 uppercase tracking-wide font-medium">
              Last: {job.last_result}
            </p>
          )}
        </div>
        <button
          onClick={onToggle}
          className={`
            mt-0.5 px-3 py-1.5 rounded-pill text-[12px] font-semibold flex-shrink-0
            transition-colors active:opacity-70
            ${job.is_active
              ? 'bg-accent-green/10 text-accent-green'
              : 'bg-divider text-text-secondary'}
          `}
        >
          {job.is_active ? 'Active' : 'Off'}
        </button>
      </div>

      <div className="h-px bg-divider mx-4" />

      <div className="px-4 py-2.5 flex items-center justify-end">
        {confirming ? (
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-text-secondary">Delete this job?</span>
            <button onClick={() => setConfirming(false)} className="text-[13px] font-semibold text-text-secondary">
              Cancel
            </button>
            <button onClick={onDelete} className="text-[13px] font-semibold text-accent-red">
              Delete
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="text-[13px] text-text-muted active:opacity-70">
            Delete
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
      setErr('Class title and time are required')
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
      setErr(e instanceof Error ? e.message : 'Failed to add job')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full bg-surface rounded-xl px-4 py-3 text-[15px] text-text-primary outline-none border border-transparent focus:border-accent-blue/40 transition-colors'
  const labelClass = 'text-[12px] font-semibold text-text-secondary uppercase tracking-wide mb-1 block'

  return (
    <Card padding="md">
      <h3 className="text-[17px] font-bold text-text-primary tracking-tight mb-4">Add Booking Job</h3>
      <div className="flex flex-col gap-3">
        <div>
          <label className={labelClass}>Class Title</label>
          <input className={inputClass} placeholder="Core Pilates" value={classTitle} onChange={e => setClassTitle(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Day of Week</label>
          <select className={inputClass} value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))}>
            {Object.entries(DAY_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass}>Class Time</label>
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
            {saving ? 'Saving…' : 'Add Job'}
          </button>
        </div>
      </div>
    </Card>
  )
}

export function PlanScreen({ appState, loading, refresh }: PlanScreenProps) {
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
        subtitle="Scheduled Bookings"
        action={showAdd ? undefined : { label: '+ Add', onClick: () => setShowAdd(true) }}
      />
      <ScreenContainer>
        {showAdd && (
          <AddJobForm onDone={() => { setShowAdd(false); refresh() }} />
        )}

        <SectionHeader title={`${appState.jobs.length} Job${appState.jobs.length !== 1 ? 's' : ''}`} />

        {loading ? (
          <Card className="flex items-center justify-center h-24">
            <span className="text-text-secondary text-[15px]">Loading…</span>
          </Card>
        ) : appState.jobs.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 py-10">
            <p className="text-[17px] font-semibold text-text-primary">No jobs yet</p>
            <p className="text-[14px] text-text-secondary text-center px-6">
              Add a booking job to get started
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-2 text-accent-blue text-[15px] font-semibold"
            >
              Add Job
            </button>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {appState.jobs.map(job => (
              <JobCard
                key={job.id}
                job={job}
                onToggle={() => handleToggle(job)}
                onDelete={() => handleDelete(job)}
              />
            ))}
          </div>
        )}
      </ScreenContainer>
    </>
  )
}
