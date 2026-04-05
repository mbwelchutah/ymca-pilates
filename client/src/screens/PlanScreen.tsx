import { useState, useEffect, useRef } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import type { AppState, Job, Phase, ScrapedClass } from '../types'
import { api } from '../lib/api'

interface PlanScreenProps {
  appState: AppState
  selectedJobId: number | null
  onSelectJob: (id: number) => void
  loading: boolean
  refresh: () => Promise<void>
}

const DAY_NAMES: Record<number, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
}

const DAY_NAME_TO_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
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

const RESULT_DOT: Record<string, 'green' | 'blue' | 'red' | 'amber' | 'gray'> = {
  booked:   'green',
  dry_run:  'blue',
  error:    'red',
  not_found:'red',
}

const RESULT_LABEL: Record<string, string> = {
  booked:   'Booked',
  dry_run:  'Simulated',
  error:    'Error',
  not_found:'Not found',
}

// Results worth surfacing on the card (transient/noise ones are excluded)
const RESULT_SHOW = new Set(['booked', 'dry_run', 'error', 'not_found'])

function formatOpens(ms: number): string {
  const now = Date.now()
  if (ms < now) return `Opened ${new Date(ms).toLocaleString([], { month: 'short', day: 'numeric' })}`
  return `Opens ${new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })}`
}

function formatShortDate(iso: string): string {
  // Parse YYYY-MM-DD as local midnight to avoid UTC off-by-one
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface JobCardProps {
  job: Job
  isWatching: boolean
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onEdit: () => void
  onSelect: () => void
}

function JobCard({ job, isWatching, onToggle, onDelete, onEdit, onSelect }: JobCardProps) {
  const [toggling, setToggling]     = useState(false)
  const [toggleErr, setToggleErr]   = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [deleteErr, setDeleteErr]   = useState<string | null>(null)
  const dayName = DAY_NAMES[job.day_of_week as unknown as number] ?? job.day_of_week
  const phase = (job.phase ?? 'unknown') as Phase

  const handleToggleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (toggling) return
    setToggling(true)
    setToggleErr(null)
    try {
      await onToggle()
    } catch {
      setToggleErr('Could not update — try again')
    } finally {
      setToggling(false)
    }
  }

  const handleConfirmDelete = async () => {
    setDeleting(true)
    setDeleteErr(null)
    try {
      await onDelete()
      // On success the card unmounts — no state reset needed
    } catch {
      setDeleteErr('Could not remove class — try again')
      setConfirming(false)
      setDeleting(false)
    }
  }

  const handleCancel = () => {
    setConfirming(false)
    setDeleteErr(null)
  }

  return (
    <Card padding="none" className={`overflow-hidden ${!job.is_active ? 'opacity-50' : ''}`}>
      {/* Watching stripe */}
      {isWatching && (
        <div className="h-1 bg-accent-blue w-full" />
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

          {/* Day + time + instructor + target date */}
          <p className="text-[13px] text-text-secondary mt-0.5">
            {dayName} at {job.class_time}
            {job.instructor ? ` · ${job.instructor}` : ''}
            {job.target_date ? ` · ${formatShortDate(job.target_date)}` : ''}
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

          {/* Last booking result */}
          {job.last_result && RESULT_SHOW.has(job.last_result) && (
            <div className="flex items-center gap-1.5 mt-1">
              <StatusDot color={RESULT_DOT[job.last_result] ?? 'gray'} size="sm" />
              <span className="text-[12px] text-text-muted">
                Last: {RESULT_LABEL[job.last_result] ?? job.last_result}
              </span>
            </div>
          )}
        </div>

        {/* Active toggle — stop propagation so it doesn't also select the job */}
        <button
          onClick={handleToggleClick}
          disabled={toggling}
          className={`
            mt-0.5 px-3 py-1.5 rounded-pill text-[12px] font-semibold flex-shrink-0
            transition-colors active:opacity-70 disabled:opacity-40
            ${job.is_active
              ? 'bg-accent-green/10 text-accent-green'
              : 'bg-divider text-text-secondary'}
          `}
        >
          {toggling ? '…' : job.is_active ? 'On' : 'Off'}
        </button>
      </div>

      <div className="h-px bg-divider mx-4" />

      {/* Footer: edit + delete */}
      <div className="px-4 py-2.5 flex flex-col gap-1.5">
        {toggleErr && (
          <p className="text-[12px] text-accent-red">{toggleErr}</p>
        )}
        {deleteErr && (
          <p className="text-[12px] text-accent-red">{deleteErr}</p>
        )}
        <div className="flex items-center justify-between">
          <button
            onClick={e => { e.stopPropagation(); onEdit() }}
            className="text-[13px] text-accent-blue font-medium active:opacity-70"
          >
            Edit
          </button>
          {confirming ? (
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-text-secondary">Remove this class?</span>
              <button
                onClick={handleCancel}
                disabled={deleting}
                className="text-[13px] font-semibold text-text-secondary disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="text-[13px] font-semibold text-accent-red disabled:opacity-40"
              >
                {deleting ? 'Removing…' : 'Remove'}
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
      </div>
    </Card>
  )
}

interface Prefill {
  classTitle: string
  dayOfWeek: number
  classTime: string
  instructor: string
  targetDate?: string
}

interface AddJobFormProps {
  onSaved:     (newJobId?: number) => void
  onCancelled: () => void
  prefill?:    Prefill | null
  editJob?:    Job | null
}

function normalizeTime(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ')
  const spaced = s.replace(/(AM|PM)$/, ' $1').replace(/\s{2,}/g, ' ').trim()
  const match = spaced.match(/^(1[0-2]|[1-9]):([0-5][0-9])\s?(AM|PM)$/)
  if (!match) return null
  return `${match[1]}:${match[2]} ${match[3]}`
}

function AddJobForm({ onSaved, onCancelled, prefill, editJob }: AddJobFormProps) {
  const isEditing    = !!editJob
  // Distinct from a plain manual-add: user arrived here via Browse → Track.
  // Only use this class becomes active when the explicit save action succeeds.
  const isFromBrowse = !isEditing && !!prefill

  // Scroll the form into view when it mounts so the user always sees it,
  // even if they were scrolled down to a card when they tapped Edit.
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // When editing, initialize from the existing job; otherwise use prefill or blank defaults.
  const initDayOfWeek = () => {
    if (editJob) {
      return DAY_NAME_TO_NUM[editJob.day_of_week] ?? parseInt(editJob.day_of_week, 10) ?? 2
    }
    return prefill?.dayOfWeek ?? 2
  }

  const [classTitle, setClassTitle] = useState(editJob?.class_title  ?? prefill?.classTitle  ?? '')
  const [dayOfWeek, setDayOfWeek]   = useState(initDayOfWeek)
  const [classTime, setClassTime]   = useState(editJob?.class_time   ?? prefill?.classTime   ?? '')
  const [instructor, setInstructor] = useState(editJob?.instructor   ?? prefill?.instructor  ?? '')
  const [targetDate, setTargetDate] = useState(editJob?.target_date  ?? prefill?.targetDate  ?? '')
  const [saving, setSaving]         = useState(false)
  const [err, setErr]               = useState<string | null>(null)

  const handleTimeBlur = () => {
    const normalized = normalizeTime(classTime)
    if (normalized) setClassTime(normalized)
  }

  const handleCancel = () => {
    console.log('[class-select] cancelled', { isEditing, isFromBrowse, classTitle })
    onCancelled()
  }

  const handleSubmit = async () => {
    if (!classTitle.trim() || !classTime.trim()) {
      setErr('Class name and time are required')
      return
    }
    const normalized = normalizeTime(classTime)
    if (!normalized) {
      setErr('Enter time like 10:45 AM')
      return
    }
    console.log('[class-select] save confirmed', { isEditing, isFromBrowse, classTitle })
    setSaving(true)
    setErr(null)
    try {
      if (isEditing && editJob) {
        await api.updateJob({
          id:          editJob.id,
          class_title: classTitle.trim(),
          day_of_week: DAY_NAMES[dayOfWeek] ?? String(dayOfWeek),
          class_time:  normalized,
          instructor:  instructor.trim() || null,
          target_date: targetDate.trim() || null,
        })
        onSaved()
      } else {
        const result = await api.addJob({
          class_title: classTitle.trim(),
          day_of_week: DAY_NAMES[dayOfWeek] ?? String(dayOfWeek),
          class_time:  normalized,
          instructor:  instructor.trim() || null,
          target_date: targetDate.trim() || null,
          is_active:   true,
        })
        onSaved(result.id)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : isEditing ? 'Couldn\'t save changes' : 'Couldn\'t add the class')
    } finally {
      setSaving(false)
    }
  }

  const inputClass = 'w-full bg-surface rounded-xl px-4 py-3 text-[15px] text-text-primary outline-none border border-transparent focus:border-accent-blue/40 transition-colors'
  const labelClass = 'text-[12px] font-semibold text-text-secondary uppercase tracking-wide mb-1 block'

  const formTitle  = isEditing    ? 'Edit Class'
                   : isFromBrowse ? 'Track This Class'
                   :                'Add a Class'

  const saveLabel  = saving       ? 'Saving…'
                   : isEditing    ? 'Save Changes'
                   : isFromBrowse ? 'Use This Class'
                   :                'Add Class'

  return (
    <div ref={formRef}>
    <Card padding="md">
      <h3 className="text-[17px] font-bold text-text-primary tracking-tight mb-4">
        {formTitle}
      </h3>
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
          <input className={inputClass} placeholder="4:20 PM" value={classTime} onChange={e => setClassTime(e.target.value)} onBlur={handleTimeBlur} />
        </div>
        <div>
          <label className={labelClass}>Instructor (optional)</label>
          <input className={inputClass} placeholder="Gretl" value={instructor} onChange={e => setInstructor(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Target date</label>
          <input type="date" className={inputClass} value={targetDate} onChange={e => setTargetDate(e.target.value)} />
          <p className="text-[11px] text-text-muted mt-1">Leave blank to book weekly on the day above</p>
        </div>
        {err && <p className="text-[13px] text-accent-red">{err}</p>}
        <div className="flex gap-2 mt-1">
          <SecondaryButton fullWidth onClick={handleCancel}>Cancel</SecondaryButton>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 bg-accent-blue text-white font-semibold text-[15px] rounded-btn px-5 py-4 active:opacity-70 disabled:opacity-40"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </Card>
    </div>
  )
}

interface BrowseSheetProps {
  onClose: () => void
  onTrack: (cls: ScrapedClass) => void
}

function BrowseSheet({ onClose, onTrack }: BrowseSheetProps) {
  const [classes, setClasses]     = useState<ScrapedClass[]>([])
  const [loading, setLoading]     = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr]             = useState<string | null>(null)
  const [refreshErr, setRefreshErr] = useState<string | null>(null)

  useEffect(() => {
    api.getScrapedClasses()
      .then(r => setClasses(r.classes))
      .catch(e => setErr(e instanceof Error ? e.message : 'Could not load schedule'))
      .finally(() => setLoading(false))
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    setRefreshErr(null)
    setErr(null)
    try {
      const r = await api.refreshSchedule()
      const updated = await api.getScrapedClasses()
      setClasses(updated.classes)
      console.log(`[Browse] Refreshed: ${r.count} classes`)
    } catch (e) {
      setRefreshErr(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const DAY_ORDER: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  }
  const sorted = [...classes].sort((a, b) => {
    const dA = DAY_ORDER[a.day_of_week] ?? 7
    const dB = DAY_ORDER[b.day_of_week] ?? 7
    if (dA !== dB) return dA - dB
    return a.class_time.localeCompare(b.class_time)
  })

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl flex flex-col"
           style={{ maxHeight: '80vh' }}>
        {/* Handle + header */}
        <div className="px-4 pt-3 pb-2 flex-shrink-0">
          <div className="w-10 h-1 bg-divider rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[18px] font-bold text-text-primary tracking-tight">Browse Schedule</h2>
              {!loading && !err && sorted.length > 0 && (
                <p className="text-[12px] text-text-muted">{sorted.length} class{sorted.length !== 1 ? 'es' : ''}</p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="text-[13px] font-semibold text-text-secondary active:opacity-70 disabled:opacity-40"
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                onClick={onClose}
                className="text-[13px] font-semibold text-accent-blue active:opacity-70"
              >
                Done
              </button>
            </div>
          </div>
          {refreshErr && (
            <p className="text-[12px] text-accent-red mt-1">{refreshErr}</p>
          )}
          <p className="text-[12px] text-text-muted mt-0.5">
            Refreshing takes ~20–30 s and requires your YMCA login.
          </p>
        </div>

        <div className="h-px bg-divider flex-shrink-0" />

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-[15px] text-text-secondary">Loading…</span>
            </div>
          ) : err ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-[14px] text-accent-red">{err}</span>
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-[16px] font-semibold text-text-primary">No classes yet</p>
              <p className="text-[14px] text-text-secondary text-center px-4">
                Tap Refresh to load classes from the YMCA schedule.
              </p>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="mt-1 text-accent-blue text-[15px] font-semibold disabled:opacity-40"
              >
                {refreshing ? 'Refreshing…' : 'Refresh Schedule'}
              </button>
            </div>
          ) : (
            <>
              {sorted.map(cls => (
                <div
                  key={cls.id}
                  className="flex items-center justify-between py-3 border-b border-divider last:border-0"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-[15px] font-semibold text-text-primary leading-tight">
                      {cls.class_title}
                    </p>
                    <p className="text-[13px] text-text-secondary mt-0.5">
                      {cls.day_of_week} · {cls.class_time}
                      {cls.instructor ? ` · ${cls.instructor}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => onTrack(cls)}
                    className="flex-shrink-0 text-[13px] font-semibold text-accent-blue bg-accent-blue/10 px-3 py-1.5 rounded-pill active:opacity-70"
                  >
                    Track
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}

export function PlanScreen({ appState, selectedJobId, onSelectJob, loading, refresh }: PlanScreenProps) {
  const [showAdd, setShowAdd]         = useState(false)
  const [showBrowse, setShowBrowse]   = useState(false)
  const [prefill, setPrefill]         = useState<Prefill | null>(null)
  const [editingJob, setEditingJob]   = useState<Job | null>(null)

  const handleToggle = async (job: Job) => {
    await api.toggleActive(job.id)
    await refresh()
  }

  const handleDelete = async (job: Job) => {
    await api.deleteJob(job.id)
    // Await so App.tsx's selectedJobId validation effect runs on fresh state —
    // if this was the watched job, the fallback selection happens immediately
    // rather than waiting for the next 5-second poll.
    await refresh()
  }

  const handleEdit = (job: Job) => {
    setEditingJob(job)
    setPrefill(null)
    setShowAdd(true)
  }

  const handleTrack = (cls: ScrapedClass) => {
    console.log('[class-select] selected', { classTitle: cls.class_title, day: cls.day_of_week, time: cls.class_time })
    setPrefill({
      classTitle: cls.class_title,
      dayOfWeek: DAY_NAME_TO_NUM[cls.day_of_week] ?? 2,
      classTime: cls.class_time,
      instructor: cls.instructor ?? '',
    })
    setShowBrowse(false)
    setEditingJob(null)
    setShowAdd(true)
  }

  // Called only when the form produces a real save (add or edit).
  // Refresh is required here so appState.jobs is up to date before
  // onSelectJob switches tabs — the Stage 1 race-condition fix.
  const handleFormSaved = async (newJobId?: number) => {
    setShowAdd(false)
    setPrefill(null)
    setEditingJob(null)
    console.log('[class-select] commit started', { newJobId })
    await refresh()
    console.log('[class-select] commit success — job list refreshed')
    if (newJobId != null) {
      console.log('[class-select] active target updated → job', newJobId)
      onSelectJob(newJobId)
      console.log('[class-select] now refreshed')
    }
  }

  // Called when the user dismisses the form without saving.
  // No refresh needed — nothing changed on the server.
  const handleFormCancelled = () => {
    setShowAdd(false)
    setPrefill(null)
    setEditingJob(null)
    console.log('[class-select] form dismissed — no save')
  }

  const showingControls = !showAdd

  return (
    <>
      <AppHeader
        subtitle="Schedule"
        action={showingControls ? { label: 'Add', onClick: () => { setEditingJob(null); setShowAdd(true) } } : undefined}
        secondaryAction={showingControls ? { label: 'Browse', onClick: () => setShowBrowse(true) } : undefined}
      />
      <ScreenContainer>
        {showAdd && (
          <AddJobForm
            key={editingJob?.id ?? 'new'}
            prefill={editingJob ? null : prefill}
            editJob={editingJob}
            onSaved={handleFormSaved}
            onCancelled={handleFormCancelled}
          />
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
              onClick={() => { setEditingJob(null); setShowAdd(true) }}
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
                onEdit={() => handleEdit(job)}
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

      {showBrowse && (
        <BrowseSheet
          onClose={() => setShowBrowse(false)}
          onTrack={handleTrack}
        />
      )}
    </>
  )
}
