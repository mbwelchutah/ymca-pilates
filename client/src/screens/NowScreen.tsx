import { useEffect, useRef, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import type { AppState, Job, Phase, SessionStatus } from '../types'
import type { SniperRunState } from '../lib/api'
import { api } from '../lib/api'
import {
  SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL, MODAL_LABEL,
  DEFAULT_READINESS, computeCompositeReadiness,
} from '../lib/readinessResolver'
import type { CompositeReadiness } from '../lib/readinessResolver'

interface NowScreenProps {
  appState: AppState
  selectedJobId: number | null
  loading: boolean
  error: string | null
  refresh: () => void
  onGoToTools?: () => void
}

// ── Booking-window helpers (all browser local time, no server time) ────────────

const DAY_IDX: Record<string, number> = {
  'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
  'Thursday': 4, 'Friday': 5, 'Saturday': 6,
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
}

/** Parse "4:20 PM" or "7:45 AM" → { hours: 0–23, minutes: 0–59 }. */
function parseClassTime(classTime: string): { hours: number; minutes: number } | null {
  const m = classTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0
  return { hours: h, minutes: min }
}

/**
 * Compute booking-open epoch ms for a job.
 *
 * Priority:
 *  1. Use the server-computed bookingOpenMs when available — it correctly
 *     accounts for target_date via the backend booking-window calculator.
 *  2. Fall back to local computation:
 *     a. If target_date is set, compute from that specific YYYY-MM-DD date.
 *     b. Otherwise find the next natural weekday occurrence (legacy path).
 */
function computeBookingOpenMs(job: Job): number | null {
  // ── 1. Prefer the server-enriched value ──────────────────────────────────
  if (job.bookingOpenMs != null) return job.bookingOpenMs

  // ── 2. Local fallback ────────────────────────────────────────────────────
  if (!job?.class_time) return null
  const time = parseClassTime(job.class_time)
  if (!time) return null

  let nextClassMs: number

  if (job.target_date) {
    // Parse YYYY-MM-DD as local midnight, place class at hours:minutes.
    const [y, m, d] = job.target_date.split('-').map(Number)
    const classDate = new Date(y, m - 1, d)
    classDate.setHours(time.hours, time.minutes, 0, 0)
    nextClassMs = classDate.getTime()
  } else {
    if (!job.day_of_week) return null
    const targetDay = DAY_IDX[job.day_of_week as string]
    if (targetDay === undefined) return null

    const now = new Date()
    let daysUntil = (targetDay - now.getDay() + 7) % 7
    if (daysUntil === 0) {
      const classToday = new Date(now)
      classToday.setHours(time.hours, time.minutes, 0, 0)
      if (now >= classToday) daysUntil = 7
    }
    const nextClass = new Date(now)
    nextClass.setDate(nextClass.getDate() + daysUntil)
    nextClass.setHours(time.hours, time.minutes, 0, 0)
    nextClass.setSeconds(0, 0)
    nextClass.setMilliseconds(0)
    nextClassMs = nextClass.getTime()
  }

  const bookingOpen = new Date(nextClassMs)
  bookingOpen.setDate(bookingOpen.getDate() - 3)
  bookingOpen.setHours(bookingOpen.getHours() - 1)
  return bookingOpen.getTime()
}

/** Derive phase from booking-open epoch ms vs browser now. */
function computePhase(bookingOpenMs: number | null): Phase {
  if (bookingOpenMs === null) return 'unknown'
  const diff = bookingOpenMs - Date.now()
  if (diff > 10 * 60 * 1000) return 'too_early'
  if (diff >  1 * 60 * 1000) return 'warmup'
  if (diff >  0)             return 'sniper'
  return 'late'
}

// ── Countdown hook ─────────────────────────────────────────────────────────────

function useCountdown(targetMs: number | null): string {
  const [display, setDisplay] = useState('')
  useEffect(() => {
    if (!targetMs) { setDisplay(''); return }
    const tick = () => {
      const diff = targetMs - Date.now()
      if (diff <= 0) { setDisplay(''); return }
      const d = Math.floor(diff / 86_400_000)
      const h = Math.floor((diff % 86_400_000) / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
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

// ── Formatters ─────────────────────────────────────────────────────────────────

const fmt = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })

// Relative-time label for "last checked" display (Stage 9F).
function relativeLabel(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs < 0)          return 'just now'
  const mins  = Math.floor(diffMs / 60_000)
  const hours = Math.floor(mins / 60)
  if (mins  < 1)  return 'just now'
  if (mins  < 60) return `${mins} min ago`
  if (hours < 24) return `${hours}h ago`
  return 'over a day ago'
}

// Hook: live relative timestamp — re-evaluates every 30 s so the label stays fresh.
function useRelativeTime(iso: string | null): string {
  const [label, setLabel] = useState(() => relativeLabel(iso))
  useEffect(() => {
    if (!iso) { setLabel(''); return }
    setLabel(relativeLabel(iso))
    const id = setInterval(() => setLabel(relativeLabel(iso)), 30_000)
    return () => clearInterval(id)
  }, [iso])
  return label
}

// Formats a preflight snapshot ISO timestamp as "Apr 5, 7:14 AM".
function formatPreflightTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))
  } catch { return '—' }
}

// Absolute date + a "· in Xd Xh" suffix when the time is in the future.
function fmtWithRelative(ms: number): string {
  const abs  = fmt(ms)
  const diff = ms - Date.now()
  if (diff <= 0) return abs
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (d > 0) return `${abs} · in ${d}d ${h}h`
  if (h > 0) return `${abs} · in ${h}h ${m}m`
  return `${abs} · in ${m}m`
}

// ── Primary result derivation (Stage 3) ────────────────────────────────────────
// Single source of truth for the most important message on the Now screen.
// Priority highest→lowest mirrors what a user actually cares about right now.

type ResultSeverity = 'success' | 'warning' | 'error' | 'info' | 'muted'

interface PrimaryResult {
  label:    string
  detail:   string
  severity: ResultSeverity
  ts?:      string  // ISO timestamp for concise "checked X" label
}

function derivePrimaryResult(opts: {
  isBooked:         boolean
  isInactive:       boolean
  isStaleBooking:   boolean
  job:              Job | null
  phase:            Phase
  sessionStatus:    SessionStatus | null
  sniperRunState:   SniperRunState | null
  composite:        CompositeReadiness
  compositeDetail:  string
  showComposite:    boolean
  locked:           boolean
  lastPreflightAt:  string | null
}): PrimaryResult {
  const {
    isBooked, isInactive, isStaleBooking, job,
    phase, sessionStatus, sniperRunState,
    composite, compositeDetail, showComposite,
    locked, lastPreflightAt,
  } = opts

  // 1. Actively booking right now
  if (locked) {
    return { label: 'Booking in progress', detail: 'The scheduler is actively attempting registration.', severity: 'info' }
  }

  // 2. Already booked this cycle
  if (isBooked) {
    const isDryRun = job?.last_result === 'dry_run'
    return {
      label:    isDryRun ? 'Test run complete' : 'Booked',
      detail:   isDryRun
        ? 'Test mode — the class was found and the action verified. Switch to Live to actually register.'
        : 'Registration confirmed for this class.',
      severity: 'success',
    }
  }

  // 3. Job is turned off
  if (isInactive) {
    return {
      label:  'Scheduling off',
      detail: 'This class is disabled. Turn it on in the Plan tab to resume automatic booking.',
      severity: 'muted',
    }
  }

  // 4. Stale booking (booked previously, now outside window)
  if (isStaleBooking) {
    return {
      label:  'Previous booking recorded',
      detail: 'The booking was for a past class. Use "Book again" to reset for the next occurrence.',
      severity: 'muted',
    }
  }

  // 5. Auth / session problem (session status takes precedence over sniper signals)
  // Auth failures are real blockers — use 'error' (red) so they stand out.
  if (
    sessionStatus?.overall === 'AUTH_NEEDS_LOGIN' ||
    sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING'
  ) {
    const isExpired = sessionStatus.overall === 'FAMILYWORKS_SESSION_MISSING'
    return {
      label:    isExpired ? 'Session expired' : 'Login required',
      detail:   isExpired
        ? 'Your schedule access has expired. Open Settings to log in again.'
        : 'Credentials needed. Open Settings to log in.',
      severity: 'error',
    }
  }

  // 6. Composite result from preflight/sniper — if we have one
  if (showComposite) {
    const severityMap: Record<CompositeReadiness['color'], ResultSeverity> = {
      green: 'success', amber: 'warning', red: 'error', gray: 'muted',
    }
    // Only show timestamp when we have a real result (not just "not tested" from stale snapshot)
    const showTs = composite.status !== 'COMPOSITE_NOT_TESTED'
    return {
      label:    composite.label,
      detail:   compositeDetail,
      severity: severityMap[composite.color],
      ts:       showTs ? (lastPreflightAt ?? undefined) : undefined,
    }
  }

  // 7. Warmup — opening very soon
  if (phase === 'warmup') {
    return {
      label:  'Opening soon',
      detail: 'The booking window opens in under 10 minutes. Run Check to verify readiness.',
      severity: 'info',
    }
  }

  // 8. Window closed, nothing booked
  if (phase === 'late') {
    return {
      label:  'Window closed',
      detail: 'The booking window for this class has passed.',
      severity: 'muted',
    }
  }

  // 9. Nothing checked yet — idle
  return {
    label:  'Not checked yet',
    detail: job ? 'Run Check to verify session, class, and booking action.' : 'Select a class in the Plan tab.',
    severity: 'muted',
  }
}

// ── Static config ──────────────────────────────────────────────────────────────

const PHASE_CONFIG: Record<Phase, { label: string }> = {
  too_early: { label: 'Waiting'       },
  warmup:    { label: 'Opening Soon'  },
  sniper:    { label: 'Booking Now'   },
  late:      { label: 'Window Closed' },
  unknown:   { label: 'Waiting'       },
}

const RESULT_CONFIG: Record<string, {
  label: string
  dotColor: 'gray' | 'green' | 'amber' | 'red' | 'blue'
}> = {
  booked:             { label: 'Booked',            dotColor: 'green' },
  dry_run:            { label: 'Test run',            dotColor: 'blue'  },
  found_not_open_yet: { label: 'Not Open Yet',       dotColor: 'amber' },
  not_found:          { label: 'Class Not Found',    dotColor: 'red'   },
  error:              { label: 'Error',              dotColor: 'red'   },
  skipped:            { label: 'Skipped',            dotColor: 'gray'  },
}

function formatDayTime(job: Job) {
  const days: Record<number, string> = {
    0:'Sunday',1:'Monday',2:'Tuesday',3:'Wednesday',
    4:'Thursday',5:'Friday',6:'Saturday',
  }
  const dayName = days[job.day_of_week as unknown as number] ?? job.day_of_week
  // When a specific date is set, show it so the user knows exactly which class they're targeting.
  const dateStr = job.target_date
    ? `, ${new Date(job.target_date + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : ''
  return `${dayName}${dateStr} at ${job.class_time}${job.instructor ? ` with ${job.instructor}` : ''}`
}

// ── Cycle-aware booking helpers ────────────────────────────────────────────────

function isThisWeekUTC(isoStr: string | null | undefined): boolean {
  if (!isoStr) return false
  const successDate  = new Date(isoStr)
  const now          = new Date()
  const daysSinceMon = (now.getUTCDay() + 6) % 7
  const weekStart    = new Date(now)
  weekStart.setUTCHours(0, 0, 0, 0)
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon)
  return successDate >= weekStart
}

function isBookingCurrentCycle(job: Job | null): boolean {
  if (!job) return false
  if (job.last_result !== 'booked' && job.last_result !== 'dry_run') return false
  if (job.target_date) {
    const today = new Date().toLocaleDateString('en-CA')
    return job.target_date >= today
  }
  return isThisWeekUTC(job.last_success_at)
}

// ── Readiness helpers ──────────────────────────────────────────────────────────

type DotColor = 'green' | 'gray' | 'red' | 'amber' | 'blue'

function readinessDotColor(value: string): DotColor {
  if (value.endsWith('_READY'))    return 'green'
  // SESSION_EXPIRED is a true problem requiring re-login — same severity as red failures.
  if (value === 'SESSION_EXPIRED') return 'red'
  // ACTION_BLOCKED means "not open yet" — an expected state, not a failure.
  // Use amber rather than red so it doesn't read as an error.
  if (value === 'ACTION_BLOCKED')  return 'amber'
  if (
    value.endsWith('_FAILED')   ||
    value.endsWith('_BLOCKED')  ||
    value.endsWith('_REQUIRED')
  ) return 'red'
  return 'gray'
}

// ── Armed-state helpers (Stage 9G) ─────────────────────────────────────────────

const ARMED_STATE_LABEL: Record<string, string> = {
  armed:           'Armed',
  almost_ready:    'Almost ready',
  waiting:         'Waiting for window',
  booking:         'Booking now',
  needs_attention: 'Needs attention',
}

function armedStateDotColor(state: string): DotColor {
  if (state === 'armed'   || state === 'booking')      return 'green'
  if (state === 'almost_ready' || state === 'waiting') return 'amber'
  if (state === 'needs_attention')                     return 'red'
  return 'gray'
}

// Derives a single concise string that describes the current blocker (if any).
function blockedReason(s: SniperRunState | null, sessionStatus: SessionStatus | null): string | null {
  // Suppress auth messages when a booking/auth operation is actively running —
  // the lock being held is not itself an auth failure.
  if (sessionStatus?.locked) return null
  // Settings session state takes priority over sniper signals
  if (sessionStatus?.overall === 'AUTH_NEEDS_LOGIN')            return sessionStatus.detail ?? 'Login required — open Settings to log in'
  if (sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING') return 'Session expired — open Settings to log in again'
  if (!s) return null
  switch (s.sniperState) {
    case 'SNIPER_BLOCKED_AUTH':      return 'Login required — session unavailable'
    case 'SNIPER_BLOCKED_DISCOVERY': return 'Class not found on schedule'
    // SNIPER_BLOCKED_ACTION = "not open yet" — primary result card already shows
    // reassurance; suppress this callout to avoid conflicting red messaging.
    case 'SNIPER_BLOCKED_ACTION':    return null
    default: return null
  }
}

// ── Compact detail row (Stage 4) ───────────────────────────────────────────────
// Visually secondary: 12 px text, sm dot, muted colors.
// Used in the collapsible details section below the primary result card.

function CompactRow({
  label, value, dotColor, detail,
}: {
  label:     string
  value:     string
  dotColor:  DotColor
  detail?:   string
}) {
  return (
    <div className="px-4 py-2.5 border-b border-divider last:border-0">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-text-muted">{label}</span>
        <div className="flex items-center gap-1.5">
          <StatusDot color={dotColor} size="sm" />
          <span className="text-[12px] font-medium text-text-secondary">{value}</span>
        </div>
      </div>
      {detail && (
        <p className="text-[11px] text-text-muted mt-0.5 leading-snug">{detail}</p>
      )}
    </div>
  )
}

// ── Readiness row sub-component ────────────────────────────────────────────────

function ReadinessRow({
  label, value, dotColor, last, detail,
}: {
  label:     string
  value:     string
  dotColor:  DotColor
  last?:     boolean
  detail?:   string
}) {
  return (
    <div className={`px-4 py-3 ${!last ? 'border-b border-divider' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-[14px] text-text-secondary">{label}</span>
        <div className="flex items-center gap-2">
          <StatusDot color={dotColor} />
          <span className="text-[14px] font-medium text-text-primary">{value}</span>
        </div>
      </div>
      {detail && (
        <p className="text-[12px] text-text-muted mt-0.5 leading-snug">{detail}</p>
      )}
    </div>
  )
}

// ── Account & Session block — Session + Schedule + Sniper + Last verified ───────

function daxkoToLabel(s: SessionStatus['daxko'] | undefined): { label: string; dotColor: DotColor } {
  switch (s) {
    case 'DAXKO_READY':      return { label: 'Ready',       dotColor: 'green' }
    case 'AUTH_NEEDS_LOGIN': return { label: 'Needs login', dotColor: 'red'   }
    default:                 return { label: 'Unknown',     dotColor: 'gray'  }
  }
}

function fwToLabel(s: SessionStatus['familyworks'] | undefined): { label: string; dotColor: DotColor } {
  switch (s) {
    case 'FAMILYWORKS_READY':           return { label: 'Ready',   dotColor: 'green' }
    // Missing/expired schedule access requires re-login — treat as red (true problem).
    case 'FAMILYWORKS_SESSION_MISSING': return { label: 'Missing', dotColor: 'red'   }
    case 'FAMILYWORKS_SESSION_EXPIRED': return { label: 'Expired', dotColor: 'red'   }
    default:                            return { label: 'Unknown', dotColor: 'gray'  }
  }
}


function formatAbsoluteTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d)
  } catch { return '—' }
}

function AccountSessionBlock({
  sessionStatus, bundleSession, verifying, authDetail,
}: {
  sessionStatus: SessionStatus | null
  bundleSession: string
  verifying:     boolean
  authDetail?: {
    verdict:  'ready' | 'login_required' | 'session_expired'
    provider: string | null
    detail:   string | null
  } | null
}) {
  // Session (Daxko) — real auth state; fall back to sniper bundle when status unavailable
  const sessionLabel = sessionStatus
    ? daxkoToLabel(sessionStatus.daxko)
    : { label: SESSION_LABEL[bundleSession as keyof typeof SESSION_LABEL] ?? '—', dotColor: readinessDotColor(bundleSession) as DotColor }

  // Schedule (FamilyWorks embed) — real state
  const fwLabel = sessionStatus
    ? fwToLabel(sessionStatus.familyworks)
    : { label: '—', dotColor: 'gray' as DotColor }

  // Last checked — shown as a subtitle on the Session row
  const lastVerified = formatAbsoluteTime(sessionStatus?.lastVerified ?? null)

  return (
    <>
      {/* Session row (Daxko) */}
      <div className="border-b border-divider px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Session</span>
          <div className="flex items-center gap-2">
            <StatusDot color={verifying ? 'gray' : sessionLabel.dotColor} />
            <span className="text-[14px] font-medium text-text-primary">
              {verifying ? 'Checking…' : sessionLabel.label}
            </span>
          </div>
        </div>
        {/* Last-checked timestamp — informative subtitle, no standalone row */}
        {lastVerified !== '—' && !verifying && (
          <p className="text-[11px] text-text-muted mt-0.5">Last checked: {lastVerified}</p>
        )}
        {authDetail?.verdict === 'login_required' && !verifying && (
          <p className="text-[12px] text-accent-red mt-0.5 leading-snug">
            {authDetail.detail ?? 'Credentials rejected — re-enter in Settings'}
          </p>
        )}
        {authDetail?.verdict === 'ready' && !verifying && (
          <p className="text-[12px] text-text-muted mt-0.5 leading-snug">Login confirmed</p>
        )}
      </div>

      {/* Schedule row (FamilyWorks) */}
      <div className="border-b border-divider px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Schedule</span>
          <div className="flex items-center gap-2">
            <StatusDot color={verifying ? 'gray' : fwLabel.dotColor} />
            <span className="text-[14px] font-medium text-text-primary">
              {verifying ? '—' : fwLabel.label}
            </span>
          </div>
        </div>
        {authDetail?.verdict === 'session_expired' && !verifying && (
          <p className="text-[12px] text-accent-amber mt-0.5 leading-snug">
            {authDetail.detail ?? 'Schedule access requires re-login — use Settings → Log in now'}
          </p>
        )}
        {authDetail?.verdict === 'ready' && !verifying && (
          <p className="text-[12px] text-text-muted mt-0.5 leading-snug">Schedule access confirmed</p>
        )}
      </div>
    </>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function NowScreen({ appState, selectedJobId, loading, error, refresh, onGoToTools }: NowScreenProps) {
  // Strict lookup — no silent fallback to jobs[0].
  // App.tsx's selectedJobId validation effect is the single source of truth:
  // when the watched job is deleted it updates selectedJobId before the next
  // render, so NowScreen never needs to guess.  When job is transiently null
  // the hero card renders its own "No class selected" empty state.
  const job = appState.jobs.find(j => j.id === selectedJobId) ?? null

  const bookingOpenMs = job ? computeBookingOpenMs(job) : null
  const phase: Phase  = computePhase(bookingOpenMs)

  const cfg      = PHASE_CONFIG[phase]
  const countdown = useCountdown(bookingOpenMs)
  const isBooked = isBookingCurrentCycle(job)
  const isStaleBooking =
    (job?.last_result === 'booked' || job?.last_result === 'dry_run') && !isBooked
  // True when the watched job exists but has been toggled off in the Plan tab.
  // The scheduler will not run it; show a distinct "Off" state so the countdown
  // and phase labels don't mislead the user into thinking booking is pending.
  const isInactive = job != null && !job.is_active

  const [resetting, setResetting] = useState(false)

  // ── Sniper readiness state ─────────────────────────────────────────────────
  const [sniperRunState, setSniperRunState] = useState<SniperRunState | null>(null)

  useEffect(() => {
    api.getSniperState().then(setSniperRunState).catch(() => {})
    const id = setInterval(() => {
      api.getSniperState().then(setSniperRunState).catch(() => {})
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  // ── Stage 9F — Background readiness state (auto-check status + last checked) ─
  // Stage 10H — Adaptive polling: 1 s during armed/warmup/sniper/confirming,
  //             30 s otherwise so the UI reacts within 1 s of any booking event.
  type BgReadiness = Awaited<ReturnType<typeof api.getReadiness>>
  const [bgReadiness, setBgReadiness] = useState<BgReadiness | null>(null)

  // Derive the current execution phase from the most recent server response.
  // We use the server-computed executionTiming.phase (authoritative) when
  // available, falling back to the client-side phase.
  const execPhase = bgReadiness?.executionTiming?.phase ?? null
  const isHotPhase =
    phase === 'sniper' ||
    execPhase === 'armed' ||
    execPhase === 'warmup' ||
    execPhase === 'confirming'
  const readinessPollMs = isHotPhase ? 1_000 : 30_000

  // The effect re-runs whenever readinessPollMs changes so the interval is
  // always in sync with the current execution phase.
  useEffect(() => {
    api.getReadiness().then(setBgReadiness).catch(() => {})
    const id = setInterval(() => api.getReadiness().then(setBgReadiness).catch(() => {}), readinessPollMs)
    return () => clearInterval(id)
  }, [readinessPollMs])

  // Live relative label — auto-refreshes every 30 s
  const lastCheckedLabel = useRelativeTime(bgReadiness?.lastCheckedAt ?? null)

  // ── Clear stale readiness data when the selected job changes OR is edited ─────
  // Sniper state is global (last-run-wins on the server).  Two triggers require
  // a wipe + fresh fetch:
  //   1. selectedJobId changes — user switched to a different class (Stage 3).
  //   2. jobFingerprint changes to a new non-null value while selectedJobId is
  //      stable — same job was edited in place (title / day / time / date).
  //
  // Stage 8 ref guard: without it, the effect fires twice on initial load:
  //   render 1 — job not yet in appState → fingerprint is null
  //   render 2 — appState populates      → fingerprint becomes "Core Pilates|…"
  // The transition null → value is NOT a user edit; skip it.
  // Track (selectedJobId, jobFingerprint) from the previous trigger using a ref
  // so we can tell the difference between an actual edit and first population.
  const jobFingerprint = job
    ? `${job.class_title}|${job.class_time}|${job.day_of_week}|${job.target_date ?? ''}`
    : null

  type Prev = { id: number | null; fp: string | null }
  const prevRef = useRef<Prev | undefined>(undefined)

  useEffect(() => {
    if (selectedJobId == null) return

    const prev = prevRef.current
    prevRef.current = { id: selectedJobId, fp: jobFingerprint }

    // Always fire when selectedJobId changes (job switch, or first render).
    const jobSwitched = prev === undefined || prev.id !== selectedJobId

    // Fire for fingerprint change only when:
    //   • selectedJobId is stable (this render is not a job switch)
    //   • previous fingerprint was non-null (job was already loaded — real edit)
    //   • fingerprint actually changed (not noise)
    const jobEdited =
      !jobSwitched &&
      prev !== undefined &&
      prev.fp !== null &&
      jobFingerprint !== null &&
      prev.fp !== jobFingerprint

    if (!jobSwitched && !jobEdited) return

    if (jobSwitched) {
      console.log('[class-select] job switched — clearing stale readiness for job', selectedJobId)
    } else {
      console.log('[class-select] job edited — clearing stale readiness for job', selectedJobId, jobFingerprint)
    }
    setAuthDetail(null)
    setDiscoveryDetail(null)
    setModalDetail(null)
    setActionDetail(null)
    setPreflightStatus(null)
    api.getSniperState().then(setSniperRunState).catch(() => {})
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobFingerprint])

  // Restore per-stage details from the persisted snapshot so the enriched
  // composite detail text survives page refreshes.  Guards prevent overwriting
  // a fresh Check Now result if a new snapshot arrives during the same session.
  // Only restore when the snapshot belongs to the currently selected job —
  // prevents cross-job data bleed when sniper state is still for the old run.
  const snapshotCheckedAt = sniperRunState?.lastPreflightSnapshot?.checkedAt ?? null
  useEffect(() => {
    const snap = sniperRunState?.lastPreflightSnapshot
    if (!snap) return
    if (sniperRunState?.jobId != null && sniperRunState.jobId !== selectedJobId) return
    if (!authDetail      && snap.authDetail)      setAuthDetail(snap.authDetail as AuthDetail)
    if (!discoveryDetail && snap.discoveryDetail) setDiscoveryDetail(snap.discoveryDetail as DiscoveryDetail)
    if (!modalDetail     && snap.modalDetail)     setModalDetail(snap.modalDetail as ModalDetail)
    if (!actionDetail    && snap.actionDetail)    setActionDetail(snap.actionDetail as ActionDetail)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotCheckedAt])

  // ── Dedicated session check state ──────────────────────────────────────────
  const [sessionStatus,   setSessionStatus]   = useState<SessionStatus | null>(null)
  const [sessionChecking, setSessionChecking] = useState(false)

  // Result badge shown after Verify Session completes — cleared on next check.
  type VerifyResult = { label: string; color: 'green' | 'amber' | 'red'; detail: string }
  const [verifyResult,    setVerifyResult]    = useState<VerifyResult | null>(null)

  useEffect(() => {
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
  }, [])

  // Unmount cleanup: clear step timer if user navigates away during a Run Check.
  useEffect(() => {
    return () => {
      if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
    }
  }, [])

  const handleVerifySession = async () => {
    if (sessionChecking) return
    setSessionChecking(true)
    setVerifyResult(null)
    try {
      const checkResult = await api.checkSession()
      // Re-fetch full status so overall/lastVerified fields are populated
      const full = await api.getSessionStatus()
      setSessionStatus(full)

      // Derive the result badge from the enriched check response.
      // Fall back to reading full status if the enriched label is missing.
      if (checkResult.valid === null) {
        setVerifyResult({ label: 'Bot busy', color: 'amber', detail: 'Try again when the booking run finishes' })
      } else if (checkResult.daxko === 'AUTH_NEEDS_LOGIN' || checkResult.valid === false) {
        setVerifyResult({ label: 'Login required', color: 'red', detail: checkResult.detail ?? 'Credentials rejected — re-enter in Settings' })
      } else if (checkResult.familyworks === 'FAMILYWORKS_SESSION_MISSING') {
        setVerifyResult({ label: 'Schedule access missing', color: 'amber', detail: 'Daxko OK — use Settings → Log in now to restore schedule access' })
      } else if (full.overall === 'DAXKO_READY' && full.familyworks === 'FAMILYWORKS_READY') {
        setVerifyResult({ label: 'Session ready', color: 'green', detail: 'Daxko and schedule access both confirmed' })
      } else {
        setVerifyResult({ label: checkResult.label ?? 'Session ready', color: 'green', detail: 'Daxko confirmed — tap Run Check for full readiness' })
      }
    } catch {
      setVerifyResult({ label: 'Verification failed', color: 'red', detail: 'Check failed — try again' })
    } finally { setSessionChecking(false) }
  }

  // Sniper state is global (last-run-wins).  Only treat it as applicable to the
  // current view when its jobId matches the selected job, or when the server
  // hasn't stored a jobId yet (legacy/null).
  const isReadinessForCurrentJob =
    sniperRunState?.jobId == null || sniperRunState.jobId === selectedJobId

  const bundle  = isReadinessForCurrentJob ? sniperRunState?.bundle : undefined
  const blocked = isReadinessForCurrentJob ? blockedReason(sniperRunState, sessionStatus) : null


  // True only when there's useful readiness data for the current job.
  const hasReadinessData = isReadinessForCurrentJob && bundle && (
    bundle.session   !== 'SESSION_UNKNOWN'       ||
    bundle.discovery !== 'DISCOVERY_NOT_TESTED'  ||
    bundle.action    !== 'ACTION_NOT_TESTED'     ||
    (bundle.modal !== undefined && bundle.modal !== 'MODAL_NOT_TESTED')
  )

  const handlePauseResume = async () => {
    try {
      if (appState.schedulerPaused) await api.resumeScheduler()
      else await api.pauseScheduler()
      refresh()
    } catch { /* ignored */ }
  }

  const handleBookAgain = async () => {
    if (!job || resetting) return
    setResetting(true)
    try {
      await api.resetBooking(job.id)
      refresh()
    } catch { /* ignored */ } finally {
      setResetting(false)
    }
  }

  const handleDryRun = async (enabled: boolean) => {
    try { await api.setDryRun(enabled); refresh() } catch { /* ignored */ }
  }

  // ── Check Now (preflight) ──────────────────────────────────────────────────
  // preflightStatus: raw status string from the last logRunSummary call.
  // Stored separately so computeCompositeReadiness() can distinguish
  // waitlist_only from action_blocked (both use ACTION_BLOCKED in the bundle).
  const [preflightRunning, setPreflightRunning] = useState(false)
  const [preflightStatus,  setPreflightStatus]  = useState<string | null>(null)
  const [checkStep,        setCheckStep]        = useState<string | null>(null)
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const CHECK_STEPS = [
    'Checking session…',
    'Loading schedule…',
    'Finding class…',
    'Opening booking modal…',
    'Checking availability…',
  ]

  // Auth, Modal, and Discovery details — populated after Check Now; persist for the session.
  type AuthDetail = {
    verdict:  'ready' | 'login_required' | 'session_expired'
    provider: string | null
    detail:   string | null
  }
  type ModalDetail = {
    verdict:        'reachable' | 'login_required' | 'blocked'
    detail:         string | null
    screenshot:     string | null
    buttonsVisible: string[] | null
    modalPreview:   string | null
  }
  type ActionDetail = {
    verdict:          'ready' | 'waitlist_only' | 'login_required' | 'full' | 'unknown'
    actionState:      string | null
    buttonsVisible:   string[] | null
    registerStrategy: string | null
    waitlistStrategy: string | null
    detail:           string | null
  }
  type DiscoveryDetail = {
    found:      boolean
    matched:    string | null
    score:      string | null
    signals:    string | null
    second:     string | null
    nearMisses: string | null
  }
  const [authDetail,      setAuthDetail]      = useState<AuthDetail | null>(null)
  const [modalDetail,     setModalDetail]     = useState<ModalDetail | null>(null)
  const [actionDetail,    setActionDetail]    = useState<ActionDetail | null>(null)
  const [discoveryDetail, setDiscoveryDetail] = useState<DiscoveryDetail | null>(null)

  const handleCheckNow = async () => {
    if (!job || preflightRunning || sessionStatus?.locked) return
    setPreflightRunning(true)

    // ── Step progress timer (Stage 1 + 6) ────────────────────────────────────
    // Cycles through CHECK_STEPS every 600 ms so the user sees meaningful
    // progress text instead of a static "Checking…". Each step is visible
    // for at least 600 ms (no flicker). Stays on last step once exhausted.
    let stepIdx = 0
    setCheckStep(CHECK_STEPS[0])
    stepTimerRef.current = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, CHECK_STEPS.length - 1)
      setCheckStep(CHECK_STEPS[stepIdx])
    }, 600)

    try {
      const result = await api.runPreflight(job.id)
      if (result.sniperState) setSniperRunState(result.sniperState)
      setPreflightStatus(result.status ?? null)
      if (result.authDetail)      setAuthDetail(result.authDetail)
      if (result.modalDetail)     setModalDetail(result.modalDetail)
      if (result.actionDetail)    setActionDetail(result.actionDetail)
      if (result.discoveryDetail) setDiscoveryDetail(result.discoveryDetail)
      // Re-fetch session-status.json so the Session/Schedule access rows reflect
      // the auth outcome that was just written by the preflight pipeline.
      api.getSessionStatus().then(setSessionStatus).catch(() => {})
      // Refresh background readiness so "Last checked" updates immediately.
      api.getReadiness().then(setBgReadiness).catch(() => {})
    } catch { setPreflightStatus('error') }
    finally {
      if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
      setCheckStep(null)
      setPreflightRunning(false)
    }
  }

  // ── Composite readiness (Stage 10) ─────────────────────────────────────────
  // Derived at render time from the live bundle + last preflight status.
  // Effective preflight status — prefer the current session value; fall back to
  // the persisted snapshot so the composite stays accurate across page refreshes.
  const effectivePreflightStatus =
    preflightStatus ?? sniperRunState?.lastPreflightSnapshot?.status ?? null

  // Timestamp of the last user-triggered Check Now (persisted in sniper-state.json).
  const lastPreflightAt = sniperRunState?.lastPreflightSnapshot?.checkedAt ?? null

  // Replaces the old per-call mapPreflightResult() priority chain.
  const composite: CompositeReadiness = computeCompositeReadiness(
    bundle ?? DEFAULT_READINESS,
    effectivePreflightStatus,
    sniperRunState?.sniperState ?? null,
  )
  // Show the composite badge only when there is something meaningful to say.
  const showComposite = effectivePreflightStatus !== null || Boolean(hasReadinessData)

  // ── Stage 8: Enriched composite detail ─────────────────────────────────────
  // Replaces the generic composite.detail with the most specific evidence from
  // per-stage detail objects populated by Check Now.  Falls back to
  // composite.detail when no stage detail is available (e.g. page refresh).
  const compositeDetail: string = (() => {
    switch (composite.status) {
      case 'COMPOSITE_READY': {
        const parts: string[] = []
        const btn = Array.isArray(actionDetail?.buttonsVisible)
          ? actionDetail!.buttonsVisible.find(b => /register|reserve/i.test(b))
          : null
        if (btn) parts.push(`"${btn}" button visible`)
        const match = discoveryDetail?.matched
        if (match) parts.push(match.length > 42 ? match.slice(0, 42) + '…' : match)
        return parts.length > 0 ? parts.join(' · ') : composite.detail
      }

      case 'COMPOSITE_WAITLIST': {
        const match = discoveryDetail?.matched
        const matchStr = match ? ` · ${match.length > 36 ? match.slice(0, 36) + '…' : match}` : ''
        return `Everything is working — class is full, waitlist is open${matchStr}`
      }

      case 'COMPOSITE_LOGIN_REQUIRED':
        // Modal login-required is more specific than a general session error
        if (composite.detail.includes('modal') && modalDetail?.detail) return modalDetail.detail
        return authDetail?.detail ?? composite.detail

      case 'COMPOSITE_CLASS_NOT_FOUND':
        if (discoveryDetail?.nearMisses) return `No exact match — nearest: ${discoveryDetail.nearMisses}`
        if (discoveryDetail?.found === false) return 'Class not visible on this day\'s schedule'
        return composite.detail

      case 'COMPOSITE_ACTION_BLOCKED':
        // Prefer the reassurance-forward composite message; fall back only if
        // actionDetail provides something genuinely more useful.
        return composite.detail

      case 'COMPOSITE_MODAL_ISSUE':
        return modalDetail?.detail ?? composite.detail

      default:
        return composite.detail
    }
  })()

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
            <button onClick={refresh} className="mt-3 text-accent-blue text-[14px] font-semibold">
              Retry
            </button>
          </Card>
        </ScreenContainer>
      </>
    )
  }

  return (
    <>
      <AppHeader
        subtitle={(() => {
          const base = isInactive ? 'Off' : cfg.label
          const flags = [
            appState.schedulerPaused && 'Paused',
            appState.dryRun          && 'Test mode',
          ].filter(Boolean).join(' · ')
          return flags ? `${base} · ${flags}` : base
        })()}
      />

      <ScreenContainer>
        {/* ── Hero card ──────────────────────────────────────────── */}
        <Card padding="md">
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
            <div className="mb-3">
              <p className="text-[22px] font-semibold text-text-primary">No class selected</p>
              <p className="text-[13px] text-text-secondary mt-1">
                Add a class in the Plan tab to start watching
              </p>
            </div>
          )}

          {/* Status banner — booked / off / sniper / late / countdown */}
          {isBooked ? (
            <div className="bg-accent-green/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="green" />
              <span className="text-[17px] font-semibold text-accent-green">
                {job?.last_result === 'dry_run' ? 'Test run' : 'Booked'}
              </span>
            </div>
          ) : isInactive ? (
            <div className="bg-surface rounded-xl px-4 py-3">
              <div className="flex items-center gap-2.5">
                <StatusDot color="gray" />
                <span className="text-[16px] text-text-secondary">Scheduling off</span>
              </div>
              <p className="text-[12px] text-text-muted mt-1 ml-[22px]">
                Turn this class on in the Plan tab to resume booking
              </p>
            </div>
          ) : phase === 'sniper' ? (
            <div className="bg-accent-blue/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">
                Booking in progress…
              </span>
            </div>
          ) : bgReadiness?.executionTiming?.phase === 'confirming' ? (
            // Stage 10E — window has opened, a live booking attempt is in flight,
            // and the bot is waiting for the page to confirm the registration.
            // Client-side phase would be 'late' at this point; the server-computed
            // executionTiming.phase overrides that to show the correct state.
            <div className="bg-accent-blue/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">
                Confirming registration…
              </span>
            </div>
          ) : phase === 'late' ? (
            <div className="bg-surface rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="gray" />
              <span className="text-[16px] text-text-secondary">Booking window has closed</span>
            </div>
          ) : execPhase === 'armed' ? (
            // Stage 10H — Armed phase: window opens in ≤45 s.
            // Show an amber pulsing indicator instead of the generic countdown.
            // The existing useCountdown hook already ticks every second so the
            // number is always fresh; the readiness poll is now 1 s so the
            // transition to "Booking in progress" is near-instantaneous.
            <div className="bg-accent-amber/10 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2.5 mb-1">
                <StatusDot color="amber" />
                <span className="text-[17px] font-semibold text-accent-amber">Armed — opening in</span>
              </div>
              <div className="ml-[22px]">
                <span className="text-[36px] font-bold text-accent-amber tabular-nums leading-none tracking-tighter">
                  {countdown || '—'}
                </span>
              </div>
            </div>
          ) : (
            <div className="bg-surface rounded-xl px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[42px] font-bold text-text-primary tabular-nums leading-none tracking-tighter">
                  {countdown || '—'}
                </span>
                <span className="text-[14px] text-text-secondary font-medium">until window opens</span>
              </div>
              {bookingOpenMs != null && (
                <p className="text-[12px] text-text-muted mt-1">
                  {execPhase === 'warmup'
                    ? `Opening soon · ${fmt(bookingOpenMs)}`
                    : `Opens ${fmt(bookingOpenMs)}`}
                </p>
              )}
            </div>
          )}

          {/* Inline blocked callout — suppressed when the primary result card below
               already communicates the same failure (Stage 7: one main truth).
               Auth failures are covered by derivePrimaryResult step 5 (sessionStatus).
               Composite red failures are covered by step 6 (composite card). */}
          {blocked && !isInactive &&
           !(sessionStatus?.overall === 'AUTH_NEEDS_LOGIN') &&
           !(sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING') &&
           !(showComposite && composite.color === 'red') && (
            <div className="mt-3 rounded-xl px-3.5 py-2.5 bg-accent-red/10">
              <p className="text-[13px] font-medium text-accent-red">
                {blocked}
              </p>
            </div>
          )}

          {/* Actions section */}
          {job && (
            <div className="mt-3 pt-3 border-t border-divider">

              {/* Stage 9G — Sniper armed state + confidence (PRIMARY trust signal) */}
              {!preflightRunning && bgReadiness?.armed?.state && (
                <div className="mb-2 flex items-center justify-center gap-1.5">
                  <StatusDot color={armedStateDotColor(bgReadiness.armed.state)} size="sm" />
                  <span className="text-[12px] font-medium text-text-secondary">
                    {ARMED_STATE_LABEL[bgReadiness.armed.state] ?? bgReadiness.armed.state}
                    {bgReadiness.confidenceScore != null && (
                      <> — {bgReadiness.confidenceScore}%</>
                    )}
                  </span>
                </div>
              )}

              {/* Stage 9F — Auto-check status + last checked time */}
              {!preflightRunning && lastCheckedLabel && (
                <div className="mb-2 flex items-center justify-center gap-1.5">
                  {!appState.schedulerPaused && (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-green flex-shrink-0 animate-pulse" />
                      <span className="text-[11px] text-text-muted">Auto-check active</span>
                      <span className="text-[11px] text-text-muted">·</span>
                    </>
                  )}
                  <span className="text-[11px] text-text-muted">Last checked {lastCheckedLabel}</span>
                </div>
              )}

              {/* Mode selector: Test / Live */}
              <div className="flex items-center bg-surface rounded-xl p-0.5 mb-2">
                <button
                  onClick={() => handleDryRun(true)}
                  disabled={preflightRunning || sessionChecking}
                  className={`flex-1 py-1.5 rounded-[10px] text-[13px] font-semibold transition-all disabled:opacity-40
                    ${appState.dryRun
                      ? 'bg-card shadow-card text-text-primary'
                      : 'text-text-muted'}`}
                >
                  Test
                </button>
                <button
                  onClick={() => handleDryRun(false)}
                  disabled={preflightRunning || sessionChecking}
                  className={`flex-1 py-1.5 rounded-[10px] text-[13px] font-semibold transition-all disabled:opacity-40
                    ${!appState.dryRun
                      ? 'bg-card shadow-card text-text-primary'
                      : 'text-text-muted'}`}
                >
                  Live
                </button>
              </div>

              {/* Stage 9H — Manual check: demoted to secondary text-link action */}
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={handleCheckNow}
                  disabled={preflightRunning || (sessionStatus?.locked ?? false)}
                  className={`flex items-center gap-1.5 text-[13px] font-medium transition-opacity
                    ${preflightRunning || (sessionStatus?.locked ?? false)
                      ? 'text-text-muted opacity-50 cursor-not-allowed'
                      : 'text-accent-blue active:opacity-50'
                    }`}
                >
                  {preflightRunning && (
                    <svg className="animate-spin h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  )}
                  {preflightRunning
                    ? 'Checking…'
                    : bgReadiness?.lastCheckedAt
                    ? 'Check again'
                    : 'Run Check'}
                </button>

                {/* Step progress text — shown while preflight is running (Stage 1 + 6) */}
                {preflightRunning && checkStep && (
                  <p className="text-[12px] text-text-muted">
                    {checkStep}
                  </p>
                )}
              </div>

              {/* Secondary action: Refresh Session — quiet text link (Stage 6) */}
              {!(sessionStatus?.locked ?? false) && !preflightRunning && (
                <div className="mt-2.5 flex flex-col items-center gap-1">
                  <button
                    onClick={handleVerifySession}
                    disabled={sessionChecking}
                    className="flex items-center gap-1.5 text-[12px] text-text-muted active:opacity-50 disabled:opacity-40"
                  >
                    {sessionChecking && (
                      <svg className="animate-spin h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    )}
                    {sessionChecking ? 'Refreshing session…' : 'Refresh session'}
                  </button>

                  {/* Inline result — single quiet line, no colored box (Stage 6) */}
                  {verifyResult && !sessionChecking && (
                    <span className={`text-[11px] ${
                      verifyResult.color === 'green' ? 'text-accent-green' :
                      verifyResult.color === 'amber' ? 'text-accent-amber' :
                      'text-accent-red'
                    }`}>
                      {verifyResult.label}
                      {verifyResult.detail ? ` · ${verifyResult.detail}` : ''}
                    </span>
                  )}
                </div>
              )}

            </div>
          )}
        </Card>

        {/* Stage 10D — Escalation banner: click_failed alert ─────────── */}
        {bgReadiness?.escalation && (
          <div className="rounded-2xl bg-accent-amber/10 border border-accent-amber/30 px-4 py-3.5">
            <div className="flex items-start gap-2.5">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5 text-accent-amber" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-accent-amber leading-snug">
                  Registration attempted — outcome unknown
                </p>
                <p className="text-[12px] text-text-muted mt-0.5 leading-snug">
                  Please check the YMCA app to confirm whether you're registered
                  {bgReadiness.escalation.classTitle ? ` for ${bgReadiness.escalation.classTitle}` : ''}.
                </p>
                <p className="text-[11px] text-text-muted mt-1">
                  Attempted at {formatPreflightTime(bgReadiness.escalation.escalatedAt)}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Primary result card (Stage 3) ──────────────────────── */}
        {(() => {
          const result = derivePrimaryResult({
            isBooked,
            isInactive,
            isStaleBooking,
            job,
            phase,
            sessionStatus,
            sniperRunState,
            composite,
            compositeDetail,
            showComposite,
            locked: sessionStatus?.locked ?? false,
            lastPreflightAt,
          })

          const bgClass =
            result.severity === 'success' ? 'bg-accent-green/10 border border-accent-green/20' :
            result.severity === 'warning' ? 'bg-accent-amber/10 border border-accent-amber/20' :
            result.severity === 'error'   ? 'bg-accent-red/10 border border-accent-red/20'     :
            result.severity === 'info'    ? 'bg-accent-blue/10 border border-accent-blue/20'   :
            'bg-surface border border-divider'

          const labelClass =
            result.severity === 'success' ? 'text-accent-green' :
            result.severity === 'warning' ? 'text-accent-amber' :
            result.severity === 'error'   ? 'text-accent-red'   :
            result.severity === 'info'    ? 'text-accent-blue'  :
            'text-text-secondary'

          const dotColor: DotColor =
            result.severity === 'success' ? 'green' :
            result.severity === 'warning' ? 'amber' :
            result.severity === 'error'   ? 'red'   :
            result.severity === 'info'    ? 'blue'  :
            'gray'

          return (
            <div className={`rounded-2xl px-4 py-4 ${bgClass}`}>
              <div className="flex items-center gap-2 mb-1">
                <StatusDot color={dotColor} />
                <span className={`text-[17px] font-semibold ${labelClass}`}>
                  {result.label}
                </span>
                {result.ts && (
                  <span className="ml-auto text-[11px] text-text-muted tabular-nums shrink-0">
                    {formatPreflightTime(result.ts)}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-text-secondary leading-snug ml-5">
                {result.detail}
              </p>
            </div>
          )
        })()}

        {/* ── Compact details section (Stage 4 + 5) ──────────────── */}
        {(sessionStatus || hasReadinessData) && (
          <Card padding="none">
            {/* ── Readiness milestones — 4-column strip (Session | Class | Modal | Action) ─── */}
            {(() => {
              // Session milestone
              const sessReady   = sessionStatus?.daxko === 'DAXKO_READY'
              const sessBlocked = sessionStatus?.overall === 'AUTH_NEEDS_LOGIN'
              const sessDot:   DotColor = sessReady ? 'green' : sessBlocked ? 'red' : 'gray'
              const sessValue = sessReady ? 'Ready' : sessBlocked ? 'Login needed' : 'Unknown'

              // Class (discovery) milestone
              const classReady   = bundle?.discovery === 'DISCOVERY_READY'
              const classFailed  = bundle?.discovery === 'DISCOVERY_FAILED'
              const classTested  = classReady || classFailed
              const classDot:   DotColor = classReady ? 'green' : classFailed ? 'red' : 'gray'
              const classValue = classReady ? 'Found' : classFailed ? 'Not found' : classTested ? 'Unknown' : 'Not checked'

              // Modal milestone (Stage 2 — persist step results)
              const modalState  = bundle?.modal
              const modalReady  = modalState === 'MODAL_READY'
              const modalFailed = modalState === 'MODAL_BLOCKED' || modalState === 'MODAL_LOGIN_REQUIRED'
              const modalTested = modalReady || modalFailed
              const modalDot: DotColor = modalReady ? 'green' : modalFailed ? 'red' : 'gray'
              const modalValue = modalReady
                ? 'Reachable'
                : modalState === 'MODAL_LOGIN_REQUIRED'
                ? 'Login req.'
                : modalFailed
                ? 'Not reachable'
                : modalTested ? 'Unknown' : 'Not checked'

              // Action milestone
              const actionReady   = bundle?.action === 'ACTION_READY'
              const actionBlocked = bundle?.action === 'ACTION_BLOCKED'
              const actionTested  = actionReady || actionBlocked
              const isWaitlist    = effectivePreflightStatus === 'waitlist_only'
              // "Not open yet" is amber (expected state); only real failures use red
              const actionDot: DotColor = actionReady ? 'green' : isWaitlist ? 'amber' : actionBlocked ? 'amber' : 'gray'
              const actionValue = actionReady ? 'Reachable' : isWaitlist ? 'Waitlist' : actionBlocked ? 'Not open yet' : actionTested ? 'Unknown' : 'Not checked'

              const milestones = [
                { label: 'Session', dot: sessDot,   value: sessValue   },
                { label: 'Class',   dot: classDot,  value: classValue  },
                { label: 'Modal',   dot: modalDot,  value: modalValue  },
                { label: 'Action',  dot: actionDot, value: actionValue },
              ]

              return (
                <div className="flex border-b border-divider">
                  {milestones.map((m, i) => (
                    <div
                      key={m.label}
                      className={`flex-1 flex flex-col items-center py-3 gap-1 ${i > 0 ? 'border-l border-divider' : ''}`}
                    >
                      <StatusDot color={m.dot} />
                      <span className="text-[12px] font-medium text-text-secondary">{m.value}</span>
                      <span className="text-[10px] text-text-muted">{m.label}</span>
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Session */}
            {sessionStatus && (() => {
              const s  = daxkoToLabel(sessionStatus.daxko)
              const lv = sessionStatus.lastVerified
                ? `Last checked: ${formatPreflightTime(sessionStatus.lastVerified)}`
                : undefined
              const authD =
                authDetail?.verdict === 'login_required'
                  ? (authDetail.detail ?? 'Credentials rejected — re-enter in Settings')
                  : authDetail?.verdict === 'ready'
                  ? 'Login confirmed'
                  : lv
              return (
                <CompactRow
                  label="Session"
                  value={sessionChecking ? 'Checking…' : s.label}
                  dotColor={sessionChecking ? 'gray' : s.dotColor}
                  detail={authD}
                />
              )
            })()}

            {/* Schedule (FamilyWorks) */}
            {sessionStatus && (() => {
              const fw = fwToLabel(sessionStatus.familyworks)
              const fwD =
                authDetail?.verdict === 'session_expired'
                  ? (authDetail.detail ?? 'Re-login required — use Settings → Log in now')
                  : authDetail?.verdict === 'ready'
                  ? 'Schedule access confirmed'
                  : undefined
              return (
                <CompactRow
                  label="Schedule"
                  value={sessionChecking ? '—' : fw.label}
                  dotColor={sessionChecking ? 'gray' : fw.dotColor}
                  detail={fwD}
                />
              )
            })()}

            {/* Discovery — only when bundle has tested it */}
            {bundle && bundle.discovery !== 'DISCOVERY_NOT_TESTED' && (
              <CompactRow
                label="Discovery"
                value={DISCOVERY_LABEL[bundle.discovery] ?? bundle.discovery}
                dotColor={readinessDotColor(bundle.discovery)}
                detail={(() => {
                  if (!discoveryDetail) return undefined
                  if (discoveryDetail.found) {
                    const parts: string[] = []
                    if (discoveryDetail.matched) parts.push(discoveryDetail.matched)
                    if (discoveryDetail.score) parts.push(`score ${discoveryDetail.score}`)
                    return parts.join(' · ') || undefined
                  }
                  return discoveryDetail.nearMisses
                    ? `Near: ${discoveryDetail.nearMisses}`
                    : 'Not visible on this day\'s schedule'
                })()}
              />
            )}

            {/* Modal — only when tested */}
            {bundle && bundle.modal !== undefined && bundle.modal !== 'MODAL_NOT_TESTED' && (
              <CompactRow
                label="Modal"
                value={MODAL_LABEL[bundle.modal] ?? bundle.modal}
                dotColor={readinessDotColor(bundle.modal)}
                detail={(() => {
                  if (!modalDetail) return undefined
                  if (modalDetail.verdict === 'reachable') {
                    const btns = Array.isArray(modalDetail.buttonsVisible)
                      ? modalDetail.buttonsVisible.join(', ')
                      : null
                    return btns ? `Buttons: ${btns}` : 'Opened and verified'
                  }
                  if (modalDetail.verdict === 'login_required') return 'Login to Register shown'
                  return modalDetail.detail ? `Could not open: ${modalDetail.detail}` : undefined
                })()}
              />
            )}

            {/* Action — only when tested */}
            {bundle && bundle.action !== 'ACTION_NOT_TESTED' && (
              <CompactRow
                label="Action"
                value={ACTION_LABEL[bundle.action] ?? bundle.action}
                dotColor={readinessDotColor(bundle.action)}
                detail={(() => {
                  if (!actionDetail) return undefined
                  switch (actionDetail.verdict) {
                    case 'ready': {
                      const btn = Array.isArray(actionDetail.buttonsVisible)
                        ? actionDetail.buttonsVisible.find(b => /register|reserve/i.test(b)) ?? 'Register'
                        : 'Register'
                      return `"${btn}" button visible`
                    }
                    case 'waitlist_only': return 'Waitlist available — class is full'
                    case 'login_required': return 'Login to Register shown'
                    case 'full':
                      return actionDetail.actionState === 'CANCEL_ONLY'
                        ? 'Cancel button visible — may already be registered'
                        : 'Register button not showing yet'
                    default: return undefined
                  }
                })()}
              />
            )}

            {/* Last run timestamp — quiet footer row */}
            {job?.last_run_at && (
              <div className="px-4 py-2 border-b border-divider last:border-0 flex items-center justify-between">
                <span className="text-[11px] text-text-muted">Last run</span>
                <span className="text-[11px] text-text-muted tabular-nums">
                  {new Date(job.last_run_at).toLocaleString([], {
                    month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })}
                </span>
              </div>
            )}

            {/* Tools link — footer of the details card */}
            {onGoToTools && (
              <button
                onClick={onGoToTools}
                className="w-full text-center text-[12px] text-text-muted active:opacity-60 py-2.5 border-t border-divider"
              >
                View details in Tools →
              </button>
            )}
          </Card>
        )}

        {/* ── Contextual action: Book again ───────────────────────── */}
        {isStaleBooking && job && (
          <SecondaryButton
            onClick={handleBookAgain}
            disabled={resetting}
            className="w-full"
          >
            {resetting ? 'Resetting…' : 'Book again'}
          </SecondaryButton>
        )}

        {/* ── Pause / Resume — quiet text link (Stage 7) ──────────── */}
        <div className="flex justify-center pb-2">
          <button
            onClick={handlePauseResume}
            className={
              appState.schedulerPaused
                ? 'text-[13px] font-medium text-accent-amber active:opacity-60'
                : 'text-[12px] text-text-muted active:opacity-50'
            }
          >
            {appState.schedulerPaused ? 'Resume scheduler' : 'Pause scheduler'}
          </button>
        </div>
      </ScreenContainer>
    </>
  )
}
