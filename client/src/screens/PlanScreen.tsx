import { useState, useEffect, useRef } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import type { AppState, Job, Phase, ScrapedClass, AuthStatusEnum } from '../types'
import { api } from '../lib/api'
import { deriveSniperPhase, SNIPER_PHASE_INFO } from '../lib/sniperPhase'
import type { SniperPhase } from '../lib/sniperPhase'
import { useCountdown } from '../lib/countdown'
import { formatOpens } from '../lib/timing'

interface PlanScreenProps {
  appState: AppState
  selectedJobId: number | null
  onSelectJob: (id: number) => void
  loading: boolean
  refresh: () => Promise<void>
  onAccount?: () => void
  accountAttention?: boolean
  authStatus?: AuthStatusEnum | null
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
  too_early: 'Scheduled',
  warmup:    'Opens Soon',
  sniper:    'Armed',
  late:      '',          // suppressed — timing line + result badge carry the messaging
  unknown:   'Scheduled',
}

const RESULT_LABEL: Record<string, string> = {
  booked:   'Confirmed', // matches Now's headline — canonical term per spec
  dry_run:  'Test run',
  error:    'Issue',     // "Error" replaced — Plan stays calm, not a debug view
  not_found:'Issue',     // "Not found" replaced — same rationale
}

// Results worth surfacing on the card (transient/noise ones are excluded)
const RESULT_SHOW = new Set(['booked', 'dry_run', 'error', 'not_found'])

// A result badge is "current" if the result is still relevant to the next class occurrence.
//   - error / not_found: always show (actionable regardless of age)
//   - target_date job:   always show (result is specific to that date)
//   - recurring booked/dry_run: show for 6 days from the booking.
//     6 days is chosen deliberately:
//       • Long enough to cover the class day itself (booking opens 3 days before).
//       • Clears before the NEXT booking window opens (7 days later), so the badge
//         never competes with the "Armed" / "Opens Soon" state of a new cycle.
//     Now uses a calendar-week boundary for its "Confirmed" headline; Plan uses this
//     slightly-longer rolling window so the badge stays visible through the class day
//     even when the booking falls in the previous UTC week.
function isResultCurrent(job: Job): boolean {
  if (job.last_result === 'error' || job.last_result === 'not_found') return true
  if (job.target_date) return true
  const refAt = job.last_result === 'booked' ? job.last_success_at : job.last_run_at
  if (!refAt) return false
  return Date.now() - new Date(refAt).getTime() < 6 * 24 * 60 * 60 * 1000
}


function formatShortDate(iso: string): string {
  // Parse YYYY-MM-DD as local midnight to avoid UTC off-by-one
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Returns the next calendar date (YYYY-MM-DD) on which the given day-of-week occurs,
// counting today if today matches (so a recurring Tuesday class on a Tuesday shows today).
function nextOccurrenceISO(dow: number): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const daysAhead = (dow - today.getDay() + 7) % 7
  const next = new Date(today)
  next.setDate(today.getDate() + daysAhead)
  return next.toISOString().slice(0, 10)
}

// Convert "H:MM AM/PM" → minutes since midnight for chronological comparison.
function timeToMinutes(t: string): number {
  const m = t.match(/^(\d+):(\d+)\s*(AM|PM)$/i)
  if (!m) return 0
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const isPM = m[3].toUpperCase() === 'PM'
  if (isPM && h !== 12) h += 12
  if (!isPM && h === 12) h = 0
  return h * 60 + min
}


// ── Stage 7: Sniper row data passed to the watched JobCard ────────────────────

interface SniperRowData {
  phase:     SniperPhase
  sessOk:    boolean
  classOk:   boolean
  modalOk:   boolean
  countdown: string
}

interface JobCardProps {
  job: Job
  isWatching: boolean
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onEdit: () => void
  onSelect: () => void
  sniperRow?: SniperRowData
}

function JobCard({ job, isWatching, onToggle, onDelete, onEdit, onSelect, sniperRow }: JobCardProps) {
  const [toggling, setToggling]     = useState(false)
  const [toggleErr, setToggleErr]   = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [deleteErr, setDeleteErr]   = useState<string | null>(null)
  const dayName  = DAY_NAMES[job.day_of_week as unknown as number] ?? job.day_of_week
  const phase    = (job.phase ?? 'unknown') as Phase
  const countdown = useCountdown(job.bookingOpenMs ?? null)

  // Details line: "Tue, Apr 14 • 4:20 PM • Gretl" — identical format for all cards.
  // Undated recurring jobs compute their next occurrence so the date is never missing.
  const effectiveDateISO = job.target_date || nextOccurrenceISO(dayOfWeekNum(job))
  const detailParts = [
    `${dayName.slice(0, 3)}, ${formatShortDate(effectiveDateISO)}`,
    job.class_time,
    job.instructor || null,
  ].filter(Boolean)
  const detailLine = detailParts.join(' • ')

  // Timing line: "Opens Apr 11 at 10:20 PM" + live countdown when window is upcoming
  const timingLine = (() => {
    if (job.bookingOpenMs == null) return null
    const abs = formatOpens(job.bookingOpenMs)
    const isFuture = job.bookingOpenMs > Date.now()
    if (isFuture && countdown) return `${abs} · in ${countdown}`
    return abs
  })()

  const handleToggleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (toggling) return
    setToggling(true)
    setToggleErr(null)
    try { await onToggle() }
    catch { setToggleErr('Could not update — try again') }
    finally { setToggling(false) }
  }

  const handleConfirmDelete = async () => {
    setDeleting(true)
    setDeleteErr(null)
    try {
      await onDelete()
    } catch {
      setDeleteErr('Could not remove — try again')
      setConfirming(false)
      setDeleting(false)
    }
  }

  return (
    <Card padding="none" className={`overflow-hidden ${!job.is_active ? 'opacity-60' : ''}`}>
      {/* Active-target accent stripe — sole selection indicator; ring removed (redundant with stripe + badge) */}
      {isWatching && <div className="h-1 bg-accent-blue w-full" />}

      {/* ── Tappable body ────────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === 'Enter' && onSelect()}
        className="px-4 pt-3.5 pb-3 cursor-pointer active:bg-[#f9f9f9] transition-colors"
      >
        {/* Row 1: class name + On/Off toggle + disclosure chevron */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
            <span className="text-[17px] font-bold text-text-primary tracking-tight leading-tight">
              {job.class_title}
            </span>
            {isWatching && (
              <span className="text-[11px] font-semibold text-accent-blue bg-accent-blue/10 px-2 py-0.5 rounded-full leading-none">
                Now
              </span>
            )}
          </div>
          {/* On/Off toggle + ›  grouped on the right */}
          <div className="flex-shrink-0 flex items-center gap-1.5">
            <button
              onClick={handleToggleClick}
              disabled={toggling}
              className={`
                px-3 py-1 rounded-full text-[12px] font-semibold
                transition-colors active:opacity-70 disabled:opacity-40
                ${job.is_active
                  ? 'bg-accent-green/10 text-accent-green'
                  : 'bg-[#f2f2f7] text-text-secondary'}
              `}
            >
              {toggling ? '…' : job.is_active ? 'On' : 'Off'}
            </button>
            {/* Disclosure indicator — communicates that the card body taps to Now */}
            <svg
              className="w-[14px] h-[14px] text-[#c8c8cc] flex-shrink-0"
              fill="none" viewBox="0 0 14 14" aria-hidden="true"
            >
              <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        {/* Row 2: Day · Date · Time · Instructor */}
        <p className="text-[14px] text-text-secondary mt-1.5 leading-snug">
          {detailLine}
        </p>

        {/* Row 3: Status
             Phase label is suppressed for the watched card when sniperRow is present —
             the sniper row below provides real-time phase information and
             the coarse PHASE_LABEL (e.g. "Armed") can contradict it ("Monitoring"). */}
        {job.is_active && (() => {
          // late phase: timing line already says "Opened [date]"; result badge covers outcome
          const showPhase = phase !== 'late' && (!isWatching || !sniperRow)
          const showBadge = !!(job.last_result && RESULT_SHOW.has(job.last_result) && isResultCurrent(job))
          if (!showPhase && !showBadge && !toggleErr) return null
          return (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {showPhase && (
                <div className="flex items-center gap-1.5">
                  <StatusDot color={PHASE_DOT[phase]} size="sm" />
                  <span className="text-[13px] text-text-secondary font-medium">
                    {PHASE_LABEL[phase]}
                  </span>
                </div>
              )}
              {showBadge && (
                <span className={`
                  text-[11px] font-semibold px-2 py-0.5 rounded-full leading-none
                  ${job.last_result === 'booked'  ? 'bg-accent-green/10 text-accent-green'
                  : job.last_result === 'dry_run' ? 'bg-accent-green/10 text-accent-green'
                  :                                 'bg-[#f2f2f7] text-text-secondary'}
                `}>
                  {RESULT_LABEL[job.last_result!]}
                </span>
              )}
              {toggleErr && (
                <span className="text-[12px] text-accent-red">{toggleErr}</span>
              )}
            </div>
          )
        })()}

        {/* Row 4: Timing — absolute date + live countdown */}
        {timingLine && (
          <p className="text-[12px] text-text-muted mt-1 tabular-nums leading-snug">
            {timingLine}
          </p>
        )}

        {/* Sniper detail row — watched card only, unchanged logic */}
        {isWatching && sniperRow && (() => {
          const { phase: sp, countdown: sniperCountdown } = sniperRow

          if (sp === 'monitoring') {
            return (
              <div key={sp} className="flex items-center gap-2 mt-2 animate-sniper-phase">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-text-muted/50" />
                <span className="text-[12px] text-text-secondary font-medium">Monitoring</span>
              </div>
            )
          }
          if (sp === 'locked') {
            return (
              <div key={sp} className="flex items-center gap-2 mt-2 animate-sniper-phase">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-accent-amber" />
                <span className="text-[12px] text-text-secondary font-medium">
                  Locked on <span className="text-accent-amber font-semibold">{job.class_title}</span>
                </span>
              </div>
            )
          }
          if (sp === 'armed') {
            return (
              <div key={sp} className="flex items-center gap-2 mt-2 animate-sniper-phase">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-accent-green" />
                <span className="text-[12px] text-accent-green font-medium">Armed</span>
              </div>
            )
          }
          if (sp === 'countdown') {
            return (
              <div key={sp} className="flex items-center gap-2 mt-2 animate-sniper-phase">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-accent-green" />
                <span className="text-[12px] text-text-secondary font-medium">
                  Firing in <span className="text-accent-green font-semibold tabular-nums">{sniperCountdown || '—'}</span>
                </span>
              </div>
            )
          }
          const info = SNIPER_PHASE_INFO[sp]
          const dotColor: Record<typeof info.dotColor, string> = {
            green: 'bg-accent-green', amber: 'bg-accent-amber',
            gray: 'bg-text-muted/50', blue: 'bg-accent-blue',
          }
          return (
            <div key={sp} className="flex items-center gap-2 mt-2 animate-sniper-phase">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor[info.dotColor]} ${info.pulse ? 'animate-pulse' : ''}`} />
              <span className="text-[12px] text-text-secondary font-medium">{info.label}</span>
            </div>
          )
        })()}
      </div>

      <div className="h-px bg-divider" />

      {/* ── Action row ───────────────────────────────────────────────── */}
      <div className="px-3 py-2.5">
        {deleteErr && (
          <p className="text-[12px] text-accent-red mb-2 px-1">{deleteErr}</p>
        )}
        {confirming ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-text-secondary">Remove this class?</span>
            <div className="flex gap-3">
              <button
                onClick={() => { setConfirming(false); setDeleteErr(null) }}
                disabled={deleting}
                className="text-[13px] font-semibold text-text-secondary disabled:opacity-40 active:opacity-70"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="text-[13px] font-semibold text-accent-red disabled:opacity-40 active:opacity-70"
              >
                {deleting ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={e => { e.stopPropagation(); onEdit() }}
              className="flex-1 py-2 rounded-xl bg-[#f2f2f7] text-accent-blue text-[14px] font-semibold active:opacity-70 transition-opacity"
            >
              Edit
            </button>
            {/* Passive state: neutral color — destructive red only appears in the confirm step */}
            <button
              onClick={() => setConfirming(true)}
              className="py-2 px-4 text-[13px] font-medium text-text-secondary active:opacity-70 transition-opacity"
            >
              Remove
            </button>
          </div>
        )}
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
                   : isFromBrowse ? 'Add to Plan'
                   :                'Add a Class'

  const saveLabel  = saving       ? 'Saving…'
                   : isEditing    ? 'Save Changes'
                   : isFromBrowse ? 'Add to Plan'
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
          <label className={labelClass}>Target Date</label>
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
      await api.refreshSchedule()
      const updated = await api.getScrapedClasses()
      setClasses(updated.classes)
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
            <p className="text-[12px] text-text-secondary mt-1">Refresh failed — try again.</p>
          )}
        </div>

        <div className="h-px bg-divider flex-shrink-0" />

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-4 py-3 flex flex-col gap-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-[15px] text-text-secondary">Loading…</span>
            </div>
          ) : err ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-[15px] font-semibold text-text-primary">Schedule unavailable</p>
              <p className="text-[14px] text-text-secondary text-center px-4">
                Tap Refresh to try loading the YMCA schedule.
              </p>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="mt-1 text-accent-blue text-[15px] font-semibold disabled:opacity-40"
              >
                {refreshing ? 'Refreshing…' : 'Refresh Schedule'}
              </button>
            </div>
          ) : sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-[16px] font-semibold text-text-primary">No classes yet</p>
              <p className="text-[14px] text-text-secondary text-center px-4">
                Tap Refresh to load classes from the YMCA schedule.
              </p>
              <p className="text-[12px] text-text-muted text-center">Takes about 30 seconds.</p>
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
                    Add to Plan
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

// ── Queue summary helpers ─────────────────────────────────────────────────────

function QueueSummary({ jobs, loading }: { jobs: Job[]; loading: boolean }) {
  const now        = Date.now()
  const active     = jobs.filter(j => j.is_active)
  const nextWindow = [...active]
    .filter(j => j.bookingOpenMs != null && j.bookingOpenMs > now)
    .sort((a, b) => (a.bookingOpenMs ?? Infinity) - (b.bookingOpenMs ?? Infinity))[0] ?? null
  const nextMs     = nextWindow?.bookingOpenMs ?? null
  const countdown  = useCountdown(nextMs)

  if (loading) return null

  const count     = jobs.length
  const countText = count === 0 ? 'No classes yet'
                  : `${count} class${count !== 1 ? 'es' : ''}`

  return (
    <div>
      <p className="text-[22px] font-bold text-text-primary tracking-tight leading-tight">
        {countText}
      </p>
      {/* With 1 class the card below already shows the same countdown — suppress here.
           With 2+ classes this summarises the EARLIEST window across all active jobs,
           which is genuinely different information from any individual card. */}
      {count > 1 && countdown ? (
        <p className="text-[14px] text-text-secondary mt-0.5">
          Next opens in{' '}
          <span className="font-semibold text-text-primary tabular-nums">{countdown}</span>
        </p>
      ) : count > 1 && nextMs ? (
        <p className="text-[14px] text-text-secondary mt-0.5">
          Next opens {new Date(nextMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </p>
      ) : null}
    </div>
  )
}

// ── Sort helpers — 'date' puts upcoming first, past last ──────────────────────

type SortMode = 'date' | 'name' | 'instructor'

// Three buckets for 'date' mode (always ascending within each bucket):
//   1. Upcoming with a specific target_date (target_date >= today)
//   2. Undated recurring (no target_date) — sorted by day-of-week, then time
//   3. Past-dated (target_date < today) — sorted by date so oldest sits last
//
// 'name' and 'instructor' are simple alphabetical sorts unchanged from before.
function dayOfWeekNum(job: Job): number {
  const raw = job.day_of_week as unknown
  if (typeof raw === 'number') return raw
  return DAY_NAME_TO_NUM[raw as string] ?? 8
}

type SortDir = 'asc' | 'desc'

function sortJobs(jobs: Job[], mode: SortMode, dir: SortDir): Job[] {
  const d = dir === 'asc' ? 1 : -1
  return [...jobs].sort((a, b) => {
    if (mode === 'name') {
      const n = a.class_title.localeCompare(b.class_title)
      if (n !== 0) return n * d
      return (timeToMinutes(a.class_time) - timeToMinutes(b.class_time)) * d
    }
    if (mode === 'instructor') {
      const ai = (a.instructor ?? '').toLowerCase()
      const bi = (b.instructor ?? '').toLowerCase()
      // Empty instructor always last regardless of direction
      if (!ai && bi) return 1
      if (ai && !bi) return -1
      const c = ai.localeCompare(bi)
      if (c !== 0) return c * d
      return a.class_title.localeCompare(b.class_title) * d
    }

    // 'date' mode — three-bucket sort.
    // Bucket order is FIXED (upcoming always before past) regardless of direction.
    // Direction only affects ordering WITHIN each bucket.
    const today = new Date().toISOString().slice(0, 10)
    const da    = a.target_date ?? ''
    const db    = b.target_date ?? ''
    const aIsPast    = !!da && da < today
    const bIsPast    = !!db && db < today
    const aIsUndated = !da
    const bIsUndated = !db

    const bucketA = aIsPast ? 2 : aIsUndated ? 1 : 0
    const bucketB = bIsPast ? 2 : bIsUndated ? 1 : 0
    if (bucketA !== bucketB) return bucketA - bucketB

    if (bucketA === 0) {
      if (da !== db) return (da < db ? -1 : 1) * d
      return (timeToMinutes(a.class_time) - timeToMinutes(b.class_time)) * d
    }
    if (bucketA === 1) {
      const dA = dayOfWeekNum(a)
      const dB = dayOfWeekNum(b)
      if (dA !== dB) return (dA - dB) * d
      return (timeToMinutes(a.class_time) - timeToMinutes(b.class_time)) * d
    }
    if (da !== db) return (da < db ? -1 : 1) * d
    return (timeToMinutes(a.class_time) - timeToMinutes(b.class_time)) * d
  })
}

const SORT_LABELS: Record<SortMode, string> = {
  date:       'Date',
  name:       'Class',
  instructor: 'Instructor',
}

// Active pill label including direction indicator
function sortPillLabel(mode: SortMode, dir: SortDir): string {
  if (mode === 'date')       return dir === 'asc' ? 'Date ↑' : 'Date ↓'
  if (mode === 'name')       return dir === 'asc' ? 'Class A–Z' : 'Class Z–A'
  /* instructor */           return dir === 'asc' ? 'Instructor A–Z' : 'Instructor Z–A'
}
const SORT_MODES: SortMode[] = ['date', 'name', 'instructor']

export function PlanScreen({ appState, selectedJobId, onSelectJob, loading, refresh, onAccount, accountAttention, authStatus }: PlanScreenProps) {
  const [showAdd, setShowAdd]         = useState(false)
  const [showBrowse, setShowBrowse]   = useState(false)
  const [prefill, setPrefill]         = useState<Prefill | null>(null)
  const [editingJob, setEditingJob]   = useState<Job | null>(null)
  const [sortMode, setSortMode]       = useState<SortMode>('date')
  const [sortDir,  setSortDir]        = useState<SortDir>('asc')

  // ── Stage 7: bgReadiness polling for the watched job ──────────────────────
  const [bgReadiness, setBgReadiness] = useState<Awaited<ReturnType<typeof api.getReadiness>> | null>(null)

  useEffect(() => {
    if (selectedJobId == null) return
    api.getReadiness().then(setBgReadiness).catch(() => {})
    const id = setInterval(() => api.getReadiness().then(setBgReadiness).catch(() => {}), 30_000)
    return () => clearInterval(id)
  }, [selectedJobId])

  // Guard: only use readiness data when it belongs to the currently selected job.
  const isReadinessForSelectedJob = bgReadiness?.jobId == null || bgReadiness?.jobId === selectedJobId

  // Watched job reference and its booking window timestamp
  const watchedJob  = appState.jobs.find(j => j.id === selectedJobId) ?? null
  const watchedPhase = (watchedJob?.phase ?? 'unknown') as Phase
  const watchedCountdown = useCountdown(watchedJob?.bookingOpenMs ?? null)

  // Compute sniper row data for the watched card.
  // Absent when job is inactive, scheduler is paused, or window has closed.
  const watchedSniperRow: SniperRowData | undefined = (() => {
    if (!watchedJob || !watchedJob.is_active || appState.schedulerPaused || watchedPhase === 'late') return undefined
    // Gate all readiness-driven inputs so stale cross-job data never bleeds through.
    const bgRdy        = isReadinessForSelectedJob ? bgReadiness : null
    const armedState   = bgRdy?.armed?.state ?? null
    const bookingActive = bgRdy?.armed?.state === 'booking'
    const execPhase    = bgRdy?.executionTiming?.phase ?? null
    const sp = deriveSniperPhase({
      armedState,
      clientPhase:   watchedPhase,
      execPhase,
      bookingActive,
    })
    return {
      phase:     sp,
      sessOk:    bgRdy?.session   === 'ready',
      classOk:   bgRdy?.discovery === 'found',
      modalOk:   bgRdy?.modal      === 'reachable',
      countdown: watchedCountdown,
    }
  })()

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
    await refresh()
    if (newJobId != null) {
      onSelectJob(newJobId)
    }
  }

  // Called when the user dismisses the form without saving.
  // No refresh needed — nothing changed on the server.
  const handleFormCancelled = () => {
    setShowAdd(false)
    setPrefill(null)
    setEditingJob(null)
  }

  return (
    <>
      <AppHeader
        subtitle="Plan"
        onAccount={onAccount}
        accountAttention={accountAttention}
        authStatus={authStatus}
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

        {!showAdd && <QueueSummary jobs={appState.jobs} loading={loading} />}

        {/* Browse primary + Add Manually secondary */}
        {!showAdd && !loading && (
          <div className="flex flex-col gap-2">
            {/* Primary — full height, blue accent, icon */}
            <button
              onClick={() => setShowBrowse(true)}
              className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl bg-accent-blue/10 text-accent-blue text-[15px] font-semibold active:opacity-70 transition-opacity"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
              </svg>
              Browse Schedule
            </button>
            {/* Secondary — shorter, lighter weight, clearly subordinate */}
            <button
              onClick={() => { setEditingJob(null); setPrefill(null); setShowAdd(true) }}
              className="flex items-center justify-center w-full py-2 rounded-2xl bg-[#f2f2f7] text-text-secondary text-[14px] font-medium active:opacity-70 transition-opacity"
            >
              Add Manually
            </button>
          </div>
        )}

        {/* Sort pills — only shown when 2+ classes are loaded */}
        {!showAdd && !loading && appState.jobs.length >= 2 && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {SORT_MODES.map(mode => {
              const active = sortMode === mode
              return (
                <button
                  key={mode}
                  onClick={() => {
                    if (active) {
                      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                    } else {
                      setSortMode(mode)
                      setSortDir('asc')
                    }
                  }}
                  className={`
                    flex-shrink-0 px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors whitespace-nowrap
                    ${active
                      ? 'bg-accent-blue text-white'
                      : 'bg-[#f2f2f7] text-text-secondary active:opacity-70'}
                  `}
                >
                  {active ? sortPillLabel(mode, sortDir) : SORT_LABELS[mode]}
                </button>
              )
            })}
          </div>
        )}

        {loading ? (
          <Card className="flex items-center justify-center h-24">
            <span className="text-text-secondary text-[15px]">Loading…</span>
          </Card>
        ) : appState.jobs.length === 0 ? (
          <Card className="flex items-center justify-center py-8">
            <p className="text-[14px] text-text-secondary text-center px-4">
              Add a class above to get started.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {sortJobs(appState.jobs, sortMode, sortDir)
              .map(job => (
              <JobCard
                key={job.id}
                job={job}
                isWatching={job.id === selectedJobId}
                onToggle={() => handleToggle(job)}
                onDelete={() => handleDelete(job)}
                onEdit={() => handleEdit(job)}
                onSelect={() => onSelectJob(job.id)}
                sniperRow={job.id === selectedJobId ? watchedSniperRow : undefined}
              />
            ))}
          </div>
        )}

        {/* Hint — only shown before the user has selected a card; once selected, the
             stripe + Now badge communicate the connection without a redundant instruction */}
        {appState.jobs.length > 0 && !showAdd && selectedJobId === null && (
          <p className="text-center text-[13px] text-text-muted px-4 pb-1">
            Tap a class to open it on Now
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
