import { useEffect, useRef, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { StatusDot } from '../components/ui/StatusDot'
import { SecondaryButton } from '../components/ui/SecondaryButton'
import { DetailRow } from '../components/ui/DetailRow'
import { ToggleRow } from '../components/ui/ToggleRow'
import type { AppState, Job, Phase, SessionStatus, AuthStatusEnum } from '../types'
import type { SniperRunState } from '../lib/api'
import { api } from '../lib/api'
import {
  SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL, MODAL_LABEL,
  DEFAULT_READINESS, computeCompositeReadiness,
} from '../lib/readinessResolver'
import type { CompositeReadiness } from '../lib/readinessResolver'
import { computeConfidence, scoreToLabelWithHysteresis } from '../lib/confidence'
import type { ConfidenceLabel } from '../lib/confidence'
import { computeArmedModel, ARMED_STATE_LABEL, armedStateDotColor } from '../lib/sniperArmed'
import type { ArmedModel } from '../lib/sniperArmed'
import { deriveSniperPhase } from '../lib/sniperPhase'
import type { SniperPhase } from '../lib/sniperPhase'

interface NowScreenProps {
  appState: AppState
  selectedJobId: number | null
  loading: boolean
  error: string | null
  refresh: () => void
  onGoToTools?: (section?: string) => void
  onAccount?: () => void
  accountAttention?: boolean
  authStatus?: AuthStatusEnum | null
  autoVerifySignal?: number
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
      const ss = String(s).padStart(2, '0')
      if (d > 0)      setDisplay(`${d}d ${h}h ${m}m`)
      else if (h > 0) setDisplay(`${h}h ${m}m ${ss}s`)
      else            setDisplay(`${m}m ${ss}s`)
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

// ── Stage 1: Top-level user-facing state machine ───────────────────────────
// Five states only. Internal signals (not checked, retry churn, modal probe,
// composite sub-states) are hidden behind this layer — they feed INTO the
// state derivation but never appear directly on the Now screen.
type TopLevelState = 'waiting' | 'ready' | 'booking' | 'success' | 'issue'

interface PrimaryResult {
  state:    TopLevelState
  label:    string
  detail:   string
  severity: ResultSeverity
  ts?:      string
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
  bookingActive:    boolean
  lastPreflightAt:  string | null
  bgArmedState:     string | null
}): PrimaryResult {
  const {
    isBooked, isInactive, job,
    phase,
    sessionStatus,
    composite, compositeDetail, showComposite,
    bookingActive, lastPreflightAt, bgArmedState,
  } = opts

  // ── STATE: booking ─────────────────────────────────────────────────────────
  // Active booking attempt is in progress right now.
  // Stage 1: only trigger on real booking runs (jobState.active via armed.state),
  //          never on preflight, verify, or background checks.
  // Stage 2: window must be open (phase === 'sniper') — no booking before open time.
  if (bookingActive && phase === 'sniper') {
    return {
      state:    'booking',
      label:    'Booking',
      detail:   'Attempting registration now',
      severity: 'info',
    }
  }

  // ── STATE: success ─────────────────────────────────────────────────────────
  // Booking confirmed for this cycle.
  if (isBooked) {
    const isDryRun = job?.last_result === 'dry_run'
    return {
      state:    'success',
      label:    isDryRun ? 'Test run complete' : 'Booked',
      detail:   isDryRun
        ? 'Test mode — class found and action verified. Switch to Live to actually register.'
        : 'Registration confirmed for this class.',
      severity: 'success',
    }
  }

  // ── STATE: issue ───────────────────────────────────────────────────────────
  // Real failures that require user attention before the system can proceed.

  // Auth / session failure — explicit blocker.
  if (
    sessionStatus?.overall === 'AUTH_NEEDS_LOGIN' ||
    sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING'
  ) {
    const isExpired = sessionStatus.overall === 'FAMILYWORKS_SESSION_MISSING'
    return {
      state:    'issue',
      label:    'Needs attention',
      detail:   isExpired
        ? 'Your session has expired. Open Settings to log in again.'
        : 'Login required. Open Settings to connect your account.',
      severity: 'error',
    }
  }

  // Job disabled — user needs to re-enable it.
  if (isInactive) {
    return {
      state:    'issue',
      label:    'Scheduling off',
      detail:   'This class is disabled. Turn it on in the Plan tab to resume.',
      severity: 'muted',
    }
  }

  // Auto-check or composite signals a real problem (red = blocking error).
  if (bgArmedState === 'needs_attention') {
    return {
      state:    'issue',
      label:    'Needs attention',
      detail:   'Auto-check detected a problem. A new check will run automatically.',
      severity: 'warning',
    }
  }
  if (showComposite && composite.color === 'red') {
    return {
      state:    'issue',
      label:    'Needs attention',
      detail:   compositeDetail,
      severity: 'error',
      ts:       lastPreflightAt ?? undefined,
    }
  }

  // ── STATE: ready ───────────────────────────────────────────────────────────
  // All checks passed — system will fire automatically at window open.
  // Stage 2: suppress 'ready' card before the window opens (phase too_early).
  // Readiness info is visible in the confidence chips; the top-level card stays
  // as 'waiting' to avoid confusion about what is actually happening right now.
  if (showComposite && composite.color === 'green' && phase !== 'too_early') {
    return {
      state:    'ready',
      label:    'Ready',
      detail:   'Everything is set — the system will book automatically when the window opens.',
      severity: 'success',
      ts:       lastPreflightAt ?? undefined,
    }
  }

  // ── STATE: waiting ─────────────────────────────────────────────────────────
  // No problem detected. Window not open yet. System is monitoring.
  // Consolidates: not checked, checked-waiting, warmup, late, stale, amber composite.
  return {
    state:    'waiting',
    label:    'Waiting',
    detail:   'Booking will start automatically when the window opens.',
    severity: 'muted',
  }
}

// ── Stage 2 / Stage 5: State hysteresis — allowed transition table ────────────
// Prevents confusing state flicker caused by transient background signals.
// The stable displayed state only changes when a transition is explicitly allowed.
//
// Stage 5 additions:
//   • from==='booking' always releases — booking run has concluded, accept next state.
//     Prevents stuck-at-booking when a run ends with warning/issue/waiting.
//   • to==='booking' still gated upstream in derivePrimaryResult (phase+bookingActive).
function isTransitionAllowed(from: TopLevelState, to: TopLevelState, severity: ResultSeverity): boolean {
  if (from === to) return true               // same state: always accept (detail may update)
  if (from === 'booking') return true        // booking concluded — always release to next state
  if (to === 'booking') return true          // active booking overrides anything (gated upstream)
  if (to === 'success') return true          // confirmed booking always wins
  if (to === 'issue' && severity === 'error') return true  // hard blockers always surface
  if (to === 'issue' && from === 'waiting') return true    // first issue from idle is fine
  if (to === 'ready' && (from === 'waiting' || from === 'issue')) return true  // promotion
  if (to === 'waiting' && (from === 'issue' || from === 'success')) return true // resolution
  // Blocked: ready→waiting (bg noise), ready→issue(warning) (premature alarm)
  return false
}

// ── Static config ──────────────────────────────────────────────────────────────

const PHASE_CONFIG: Record<Phase, { label: string }> = {
  too_early: { label: 'Waiting'       },
  warmup:    { label: 'Opening Soon'  },
  sniper:    { label: 'Booking'       },
  late:      { label: 'Window Closed' },
  unknown:   { label: 'Waiting'       },
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

// ── Auto-verify tracking (module-level so it survives tab remounts) ────────────
// Stores the last autoVerifySignal value that NowScreen already acted on so
// switching tabs and back doesn't retrigger a verify that already ran.
let _lastAutoVerifyFired = 0

// ── Component ──────────────────────────────────────────────────────────────────

export function NowScreen({ appState, selectedJobId, loading, error, refresh, onGoToTools, onAccount, accountAttention, authStatus, autoVerifySignal }: NowScreenProps) {
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

  // Stage 9 — banner-is-complete guard.
  // When the status-banner block (countdown area) is already showing a definitive
  // non-countdown state, the Stage 1 result card and trust line below it would be
  // redundant.  Suppress both when this flag is true to avoid duplicate messaging.
  // Conditions that make the banner a complete state display (not just a countdown):
  //   isBooked          → banner shows "Booked"
  //   isInactive        → banner shows "Scheduling off"
  //   phase === 'sniper'         → banner shows "Booking in progress…"
  //   execPhase === 'confirming' → banner shows "Confirming registration…"
  const bannerIsComplete =
    isBooked || isInactive || phase === 'sniper' || execPhase === 'confirming'

  // The effect re-runs whenever readinessPollMs changes so the interval is
  // always in sync with the current execution phase.
  useEffect(() => {
    api.getReadiness().then(setBgReadiness).catch(() => {})
    const id = setInterval(() => api.getReadiness().then(setBgReadiness).catch(() => {}), readinessPollMs)
    return () => clearInterval(id)
  }, [readinessPollMs])

  // Live relative label — auto-refreshes every 30 s
  const lastCheckedLabel = useRelativeTime(bgReadiness?.lastCheckedAt ?? null)

  // Stage 5: freshness — always "checked just now" / "checked N min ago"
  const lastCheckedText = lastCheckedLabel ? `checked ${lastCheckedLabel}` : null

  // Guard: only treat bgReadiness data as valid for the currently selected job.
  // bgReadiness.jobId === null means legacy / not yet tagged — treat as applicable.
  const isReadinessForSelectedJob =
    bgReadiness?.jobId == null || bgReadiness?.jobId === selectedJobId

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
    setStableResult(null)          // Stage 2: reset hysteresis on job switch
    setStableConfidenceLabel(null) // Stage 4: reset label hysteresis on job switch
    api.getSniperState().then(setSniperRunState).catch(() => {})
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
    api.getReadiness().then(setBgReadiness).catch(() => {})
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

  // Stage 6 — Sniper armed model (Layer C).
  // Computed client-side from the 5 normalized readiness fields so the model is
  // independently typed and doesn't require the server's `armed` sub-object to
  // be present.  The server's `armed.nextWindow`, `watchingActive`, `autoRetry`
  // are still used as context inputs since the client can't compute them locally.
  const sniperArmed: ArmedModel | null = (() => {
    if (!isReadinessForSelectedJob || !bgReadiness) return null
    const { session, schedule, discovery, modal } = bgReadiness
    return computeArmedModel({
      session,
      schedule,
      discovery,
      modal,
      bookingActive:   bgReadiness.armed?.state === 'booking',
      nextWindow:      bgReadiness.armed?.nextWindow      ?? null,
      autoCheckActive: bgReadiness.armed?.watchingActive  ?? false,
      autoRetry:       bgReadiness.armed?.autoRetry       ?? false,
    })
  })()

  useEffect(() => {
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
  }, [])

  // Unmount cleanup: clear step timer if user navigates away during a Run Check.
  useEffect(() => {
    return () => {
      if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
    }
  }, [])


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
  const [checkStep,    setCheckStep]    = useState<string | null>(null)
  const [checkElapsed,         setCheckElapsed]         = useState<number>(0)
  // Stage 2: stable display result — applies hysteresis so the card doesn't flicker.
  const [stableResult, setStableResult] = useState<PrimaryResult | null>(null)
  // Stage 4: stable confidence label — separate hysteresis for the label so it
  // doesn't oscillate from small score changes.
  const [stableConfidenceLabel, setStableConfidenceLabel] = useState<ConfidenceLabel | null>(null)
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Time-gated step labels — each activates once the elapsed seconds threshold is crossed.
  // Thresholds are approximate real-world timings for the Playwright preflight pipeline.
  const CHECK_STEPS: { label: string; atSec: number }[] = [
    { label: 'Connecting…',       atSec: 0  },
    { label: 'Checking login…',   atSec: 4  },
    { label: 'Loading schedule…', atSec: 11 },
    { label: 'Finding class…',    atSec: 23 },
    { label: 'Opening modal…',    atSec: 36 },
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
    if (!job || preflightRunning || bgReadiness?.armed?.state === 'booking') return
    setPreflightRunning(true)

    // ── Step progress timer ───────────────────────────────────────────────────
    // Ticks every 1 s.  Elapsed count is shown live to the user.
    // Step label advances only when the elapsed threshold for the next step
    // is crossed — so each stage is visible for its realistic duration.
    let elapsed = 0
    setCheckElapsed(0)
    setCheckStep(CHECK_STEPS[0].label)
    stepTimerRef.current = setInterval(() => {
      elapsed += 1
      setCheckElapsed(elapsed)
      const current = [...CHECK_STEPS].reverse().find(s => elapsed >= s.atSec)
      if (current) setCheckStep(current.label)
    }, 1000)

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
      setCheckElapsed(0)
      setPreflightRunning(false)
    }
  }

  // ── Auto-verify on startup / class change ──────────────────────────────────
  // Parent increments autoVerifySignal when it wants a verify triggered (once
  // on first load, and again each time the user selects a different class).
  // lastFiredSignal persists across remounts via ref so tab-switching doesn't
  // retrigger a verify that already ran at this signal level.
  const handleCheckNowRef = useRef(handleCheckNow)
  handleCheckNowRef.current = handleCheckNow
  useEffect(() => {
    if (!autoVerifySignal || autoVerifySignal <= _lastAutoVerifyFired) return
    _lastAutoVerifyFired = autoVerifySignal
    handleCheckNowRef.current()
  }, [autoVerifySignal])

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

  // ── Stage 3: Confidence score ───────────────────────────────────────────────
  // Computed client-side from all 5 normalized readiness signals in bgReadiness.
  // Falls back to the server-supplied score when bgReadiness isn't populated yet.
  // Intentionally NOT inside PrimaryResult / stableResult so it always reflects
  // the latest data regardless of hysteresis state.
  const confidenceScore: number | null = (() => {
    if (!isReadinessForSelectedJob || !bgReadiness) return null
    const { session, schedule, discovery, modal, action } = bgReadiness
    if (!session || !schedule || !discovery || !modal || !action) {
      return bgReadiness.confidenceScore ?? null
    }
    return computeConfidence({ session, schedule, discovery, modal, action }).score
  })()

  // ── Stage 4: Contradiction-safe confidence label ────────────────────────────
  // Reads stableConfidenceLabel (updated via hysteresis effect) then clamps it
  // against the top-level state to prevent logical contradictions:
  //   success state  → never show "Low confidence"
  //   issue (error)  → never show "High confidence"
  const confidenceLabel: ConfidenceLabel | null = (() => {
    if (!stableConfidenceLabel) return null
    const topState = stableResult?.state
    const severity = stableResult?.severity
    if (topState === 'success') {
      if (stableConfidenceLabel === 'Low confidence') return 'Medium confidence'
    }
    if (topState === 'issue' && severity === 'error') {
      if (stableConfidenceLabel === 'High confidence') return 'Medium confidence'
    }
    return stableConfidenceLabel
  })()

  // ── Stage 2: Compute current result + apply hysteresis ─────────────────────
  // currentResult is the raw derived value from this render's data.
  // stableResult is what the card actually displays — transitions are gated.
  const currentResult: PrimaryResult | null = job ? derivePrimaryResult({
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
    bookingActive: bgReadiness?.armed?.state === 'booking',
    lastPreflightAt,
    bgArmedState: sniperArmed?.state ?? null,
  }) : null

  // Hysteresis effect — runs whenever the derived state or severity changes.
  // Uses functional setter so it reads the latest stableResult without being
  // a dependency (avoids infinite loops).
  useEffect(() => {
    if (!currentResult) return
    setStableResult(prev => {
      if (!prev) return currentResult
      if (!isTransitionAllowed(prev.state, currentResult.state, currentResult.severity)) return prev
      return currentResult
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentResult?.state, currentResult?.severity])

  // Stage 4: Label hysteresis effect — only updates stableConfidenceLabel when
  // the score change is large enough to cross a grace-zone boundary.
  useEffect(() => {
    if (confidenceScore == null) return
    setStableConfidenceLabel(prev => scoreToLabelWithHysteresis(confidenceScore, prev))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confidenceScore])

  if (loading) {
    return (
      <>
        <AppHeader subtitle="Loading…" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} />
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
        <AppHeader subtitle="Error" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} />
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
        onAccount={onAccount}
        accountAttention={accountAttention}
        authStatus={authStatus}
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
                <span className="text-[17px] font-semibold text-accent-amber">Opening in</span>
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

          {/* ── Sniper Timeline Strip — 5-segment progress bar ───────────── */}
          {/* Replaces the single-dot status bar. Shown for all phases        */}
          {/* including firing/confirming (full bar reinforces completion).   */}
          {job && !isBooked && !isInactive && phase !== 'late' && (() => {
            const sp = deriveSniperPhase({
              armedState:    sniperArmed?.state ?? null,
              clientPhase:   phase,
              execPhase:     execPhase ?? null,
              bookingActive: bgReadiness?.armed?.state === 'booking',
            })

            // Phase → fill count, filled-segment colour, fire animation flag
            const STRIP: Record<SniperPhase, { filled: number; color: string; fireAnim: boolean }> = {
              monitoring: { filled: 1, color: 'bg-text-muted/50', fireAnim: false },
              locked:     { filled: 2, color: 'bg-accent-amber',  fireAnim: false },
              armed:      { filled: 3, color: 'bg-accent-green',  fireAnim: false },
              countdown:  { filled: 4, color: 'bg-accent-green',  fireAnim: false },
              firing:     { filled: 5, color: 'bg-accent-green',  fireAnim: true  },
              confirming: { filled: 5, color: 'bg-accent-green', fireAnim: true  },
            }
            const { filled, color, fireAnim } = STRIP[sp]

            return (
              <div key={sp} className="mt-2 flex items-center gap-3 animate-sniper-phase">
                {/* 5 segment dots */}
                <div className="flex items-center gap-1.5">
                  {[0, 1, 2, 3, 4].map(i => {
                    const isFilled   = i < filled
                    // Countdown: the 4th dot (index 3) is the active frontier —
                    // render it slightly larger to signal it's the leading edge.
                    const isFrontier = sp === 'countdown' && i === 3
                    // Fire moment: 5th dot (index 4) gets the scale-pop animation.
                    const isFireDot  = fireAnim && i === 4
                    return (
                      <span
                        key={i}
                        className={[
                          'rounded-full flex-shrink-0',
                          isFrontier ? 'w-2.5 h-2.5' : 'w-2 h-2',
                          isFilled ? color : 'bg-divider',
                          isFireDot ? 'animate-sniper-fire' : '',
                        ].filter(Boolean).join(' ')}
                      />
                    )
                  })}
                </div>
                {/* Countdown phase: show "Firing in X" text inline */}
                {sp === 'countdown' && (
                  <span className="text-[13px] text-text-secondary font-medium">
                    {'Firing in '}
                    <span className="text-accent-green font-semibold tabular-nums">{countdown || '—'}</span>
                  </span>
                )}
              </div>
            )
          })()}

          {/* ── Confidence Ring ───────────────────────────────────────────────────
               Stage 4: wired to real confidenceScore (0-100 or null).
               Fill formula: frac = score / 100  (continuous, 0–1 range).
               Thresholds used for colour/label only — the arc itself is linear.
               Arc animates via stroke-dashoffset CSS transition (0.6s ease).
               Hidden entirely when confidenceScore is null (no data yet).    */}
          {job && !isBooked && !isInactive && confidenceScore != null && (() => {
            const R    = 16
            const circ = 2 * Math.PI * R   // ≈ 100.53

            const score = confidenceScore   // live value from readiness poller
            const frac  = Math.max(0, Math.min(1, score / 100))
            const offset = circ * (1 - frac)

            // Stage 3 + 5: label and arc color from score bucket (calm iOS tones)
            const ringLabel     = score >= 70 ? 'High'  : score >= 40 ? 'Likely'  : 'At risk'
            const arcColor      = score >= 70
              ? 'var(--color-accent-green)'
              : score >= 40
              ? 'var(--color-accent-amber)'
              : 'var(--color-accent-red)'
            const labelClass    = score >= 70
              ? 'text-accent-green'
              : score >= 40
              ? 'text-accent-amber'
              : 'text-accent-red'

            return (
              <div className="mt-3 flex flex-col items-center gap-1">
                <svg
                  width="44" height="44" viewBox="0 0 40 40"
                  className="-rotate-90"
                  aria-hidden="true"
                >
                  {/* Track — always neutral */}
                  <circle
                    cx="20" cy="20" r={R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-divider"
                  />
                  {/* Arc — stroke set directly so CSS stroke transition animates color */}
                  <circle
                    cx="20" cy="20" r={R}
                    fill="none"
                    strokeWidth="3"
                    strokeDasharray={circ}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{
                      stroke: arcColor,
                      transition: 'stroke-dashoffset 0.6s ease, stroke 0.4s ease',
                    }}
                  />
                </svg>
                {/* Label — small, matches arc color, secondary to the ring */}
                <span className={`text-[11px] tracking-wide ${labelClass}`}>{ringLabel}</span>
              </div>
            )
          })()}

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

              {/* ── Layer A — Primary result card: top-level state machine (Stages 1–2) ── */}
              {/* Stage 9: suppressed when the status banner already shows a complete state */}
              {!bannerIsComplete && job && (() => {
                const result = stableResult ?? currentResult
                if (!result) return null
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
                  <div className={`rounded-xl px-3.5 py-3 mt-2 mb-2 ${bgClass}`}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <StatusDot color={dotColor} />
                      <span className={`text-[15px] font-semibold ${labelClass}`}>
                        {result.label}
                      </span>
                      {result.ts && (
                        <span className="ml-auto text-[11px] text-text-muted tabular-nums shrink-0">
                          {formatPreflightTime(result.ts)}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-text-secondary leading-snug ml-5">
                      {result.detail}
                    </p>
                  </div>
                )
              })()}

              {/* ── Trust line: State · Confidence · Freshness ── */}
              {/* Calm reassurance summary — suppressed when banner already shows full state.    */}
              {/* Always rendered as a strict 3-part line; hidden when any part is unavailable. */}
              {!bannerIsComplete && (() => {
                if (!isReadinessForSelectedJob) return null

                // Running: "Confirming · <confidence> · checked just now"
                // Requires confidence to maintain strict 3-part format; hide otherwise.
                if (preflightRunning && confidenceLabel != null) {
                  return (
                    <div className="mb-2 flex items-center justify-center gap-1.5">
                      <StatusDot color="gray" size="sm" />
                      <span className="text-[12px] text-text-secondary">
                        <span className="font-medium">Confirming</span>
                        <span className="text-text-muted font-normal"> · {confidenceLabel}</span>
                        <span className="text-text-muted font-normal"> · checked just now</span>
                      </span>
                    </div>
                  )
                }
                if (preflightRunning) return null

                // Steady state: require all 3 parts — hide rather than show partial line
                const stateLabel = sniperArmed?.state ? ARMED_STATE_LABEL[sniperArmed.state] : null
                if (!stateLabel || confidenceLabel == null || !lastCheckedText) return null

                return (
                  <div className="mb-2 flex items-center justify-center gap-1.5">
                    <StatusDot color={armedStateDotColor(sniperArmed!.state)} size="sm" />
                    <span className="text-[12px] text-text-secondary">
                      <span className="font-medium">{stateLabel}</span>
                      <span className="text-text-muted font-normal"> · {confidenceLabel}</span>
                      <span className="text-text-muted font-normal"> · {lastCheckedText}</span>
                    </span>
                  </div>
                )
              })()}

              {/* Step 3 — Compact utility row: inline mode toggle + verify button */}
              <div className="flex items-center justify-between mt-1 pt-2 border-t border-divider">
                {/* Inline Live / Test toggle — subdued, no heavy background */}
                <div className="flex items-center gap-0.5 text-[12px]">
                  <button
                    onClick={() => handleDryRun(false)}
                    disabled={preflightRunning}
                    className={`px-2 py-1 rounded-md transition-all disabled:opacity-40
                      ${!appState.dryRun
                        ? 'bg-surface font-semibold text-text-primary'
                        : 'text-text-muted'}`}
                  >
                    Live
                  </button>
                  <span className="text-text-muted opacity-30 select-none">/</span>
                  <button
                    onClick={() => handleDryRun(true)}
                    disabled={preflightRunning}
                    className={`px-2 py-1 rounded-md transition-all disabled:opacity-40
                      ${appState.dryRun
                        ? 'bg-surface font-semibold text-text-primary'
                        : 'text-text-muted'}`}
                  >
                    Test
                  </button>
                </div>

                {/* Verify — secondary reassurance action (Stage 8: demoted from primary) */}
                <button
                  onClick={handleCheckNow}
                  disabled={preflightRunning || bgReadiness?.armed?.state === 'booking'}
                  className={`flex items-center gap-1.5 text-[12px] font-normal transition-opacity
                    ${preflightRunning || bgReadiness?.armed?.state === 'booking'
                      ? 'text-text-muted opacity-50 cursor-not-allowed'
                      : 'text-text-secondary active:opacity-50'
                    }`}
                >
                  {preflightRunning && (
                    <svg className="animate-spin h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  )}
                  {preflightRunning ? 'Checking…' : 'Verify'}
                </button>
              </div>

              {/* Step progress text — shown while preflight is running */}
              {preflightRunning && checkStep && (
                <p className="text-center text-[11px] text-text-muted mt-1">
                  {checkStep}
                  <span className="opacity-50"> · {checkElapsed}s</span>
                </p>
              )}

            </div>
          )}
        </Card>

        {/* Stage 5 — Session attention nudge ───────────────────────────
             Shown only when accountAttention is true (explicit known-failure:
             AUTH_NEEDS_LOGIN or FAMILYWORKS_SESSION_MISSING). No dismiss —
             it disappears naturally once the session is fixed.              */}
        {accountAttention && (
          <button
            onClick={onAccount}
            className="w-full rounded-2xl bg-accent-amber/10 border border-accent-amber/20 px-4 py-3 flex items-center gap-3 text-left active:opacity-70 transition-opacity"
          >
            <svg className="w-4 h-4 flex-shrink-0 text-accent-amber" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-accent-amber leading-snug">
                Session needs attention
              </p>
              <p className="text-[12px] text-text-muted mt-0.5">
                Tap to review and sign in
              </p>
            </div>
            <svg className="w-4 h-4 flex-shrink-0 text-accent-amber/60" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
        )}

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

        {/* ── Compact details section (Stage 4 + 5) ──────────────── */}
        {(sessionStatus || hasReadinessData || (isReadinessForSelectedJob && bgReadiness)) && (
          <Card padding="none">
            {/* ── Readiness milestones — 4-column strip (Session | Class | Modal | Action) ─── */}
            {(() => {
              // bgRdy: background readiness normalized fields (job-gated).
              // Used as a sticky fallback when no explicit preflight bundle exists.
              const bgRdy = isReadinessForSelectedJob ? bgReadiness : null

              // ── Session chip ───────────────────────────────────────────────
              // Labels: Ready / Needs login / Monitoring
              // Primary: sessionStatus (live check). Fallback: bgRdy.session.
              const sessReady   = sessionStatus?.daxko === 'DAXKO_READY' ||
                                  (!sessionStatus && bgRdy?.session === 'ready')
              const sessBlocked = sessionStatus?.overall === 'AUTH_NEEDS_LOGIN'   ||
                                  sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING' ||
                                  (!sessionStatus && bgRdy?.session === 'error')
              const sessDot:   DotColor = sessReady ? 'green' : sessBlocked ? 'red' : 'gray'
              const sessValue            = sessReady ? 'Ready' : sessBlocked ? 'Needs login' : 'Monitoring'

              // ── Class chip (discovery) ─────────────────────────────────────
              // Labels: Found / Missing / Monitoring
              // bgRdy is fresher (updated by background loops); bundle is fallback.
              // Pre-window (too_early): only bg signal — don't surface stale bundle failure.
              const bgClassFound   = bgRdy?.discovery === 'found'
              const bgClassMissing = bgRdy?.discovery === 'missing'
              const classFound   = phase === 'too_early'
                ? bgClassFound
                : bgClassFound || (!bgClassFound && !bgClassMissing && bundle?.discovery === 'DISCOVERY_READY')
              const classMissing = phase !== 'too_early' &&
                                   (bgClassMissing ||
                                    (!bgClassFound && !bgClassMissing && bundle?.discovery === 'DISCOVERY_FAILED'))
              const classDot:   DotColor = classFound ? 'green' : classMissing ? 'red' : 'gray'
              const classValue           = classFound ? 'Found' : classMissing ? 'Missing' : 'Monitoring'

              // ── Modal chip ─────────────────────────────────────────────────
              // Labels: Reachable / Blocked / Monitoring
              // bgRdy first; bundle fallback. Pre-window: bg only, no stale Blocked.
              const bgModalOk  = bgRdy?.modal === 'reachable'
              const bgModalBad = bgRdy?.modal === 'blocked'
              const modalOk  = phase === 'too_early'
                ? bgModalOk
                : bgModalOk || (!bgModalOk && !bgModalBad && bundle?.modal === 'MODAL_READY')
              const modalBad = phase !== 'too_early' &&
                               (bgModalBad ||
                                (!bgModalOk && !bgModalBad &&
                                 (bundle?.modal === 'MODAL_BLOCKED' || bundle?.modal === 'MODAL_LOGIN_REQUIRED')))
              const modalDot:  DotColor = modalOk ? 'green' : modalBad ? 'red' : 'gray'
              const modalValue           = modalOk ? 'Reachable' : modalBad ? 'Blocked' : 'Monitoring'

              // ── Action chip ────────────────────────────────────────────────
              // Labels: Not open yet / Ready / Waitlist / Unavailable / Monitoring
              // Stage 5: before window always shows "Not open yet" (gray, expected).
              // Post-window: bgRdy first, bundle fallback.
              const isWaitlist = effectivePreflightStatus === 'waitlist_only'
              let actionDot: DotColor
              let actionValue: string
              if (phase === 'too_early') {
                actionDot   = 'gray'
                actionValue = 'Not open yet'
              } else {
                const bgAction     = bgRdy?.action ?? 'unknown'
                const bundleAction = bundle?.action !== 'ACTION_NOT_TESTED' ? bundle?.action : null

                const actionReady   = !isWaitlist && (
                  bgAction === 'ready' ||
                  (bgAction === 'unknown' && bundleAction === 'ACTION_READY')
                )
                const actionUnavail = !isWaitlist && (
                  bgAction === 'blocked' || bgAction === 'not_open' ||
                  (bgAction === 'unknown' && bundleAction === 'ACTION_BLOCKED')
                )

                if (isWaitlist) {
                  actionDot = 'amber'; actionValue = 'Waitlist'
                } else if (actionReady) {
                  actionDot = 'green'; actionValue = 'Ready'
                } else if (actionUnavail) {
                  actionDot = 'amber'; actionValue = 'Unavailable'
                } else {
                  actionDot = 'gray'; actionValue = 'Monitoring'
                }
              }

              const hasRunEvents = (sniperRunState?.events?.length ?? 0) > 0
              const milestones = [
                { label: 'Session', dot: sessDot,   value: sessValue,   section: 'tools-readiness'                                    },
                { label: 'Class',   dot: classDot,  value: classValue,  section: hasRunEvents ? 'tools-run-events' : 'tools-readiness' },
                { label: 'Modal',   dot: modalDot,  value: modalValue,  section: hasRunEvents ? 'tools-run-events' : 'tools-readiness' },
                { label: 'Action',  dot: actionDot, value: actionValue, section: hasRunEvents ? 'tools-run-events' : 'tools-readiness' },
              ]

              return (
                <div className="flex border-b border-divider">
                  {milestones.map((m, i) => {
                    const base = `flex-1 flex flex-col items-center py-3 gap-1 ${i > 0 ? 'border-l border-divider' : ''}`
                    const inner = (
                      <>
                        <StatusDot color={m.dot} />
                        <span className="text-[12px] font-medium text-text-secondary">{m.value}</span>
                        <span className="text-[10px] text-text-muted">{m.label}</span>
                      </>
                    )
                    return onGoToTools ? (
                      <button
                        key={m.label}
                        onClick={() => onGoToTools(m.section)}
                        className={`${base} active:bg-divider/50 transition-colors`}
                      >
                        {inner}
                      </button>
                    ) : (
                      <div key={m.label} className={base}>{inner}</div>
                    )
                  })}
                </div>
              )
            })()}

            {/* Tools link — context-aware handoff */}
            {onGoToTools && (() => {
              const hasSessionProblem =
                sessionStatus?.daxko !== 'DAXKO_READY' ||
                sessionStatus?.familyworks !== 'FAMILYWORKS_READY'
              const hasRunEvents = (sniperRunState?.events?.length ?? 0) > 0

              let section: string
              let label: string

              if (hasSessionProblem) {
                section = 'tools-readiness'
                label   = 'Check session in Tools →'
              } else if (hasRunEvents) {
                section = 'tools-run-events'
                label   = 'View run events in Tools →'
              } else {
                section = 'tools-readiness'
                label   = 'View details in Tools →'
              }

              return (
                <button
                  onClick={() => onGoToTools(section)}
                  className="w-full text-center text-[13px] font-medium text-accent-blue active:opacity-60 py-3 border-t border-divider"
                >
                  {label}
                </button>
              )
            })()}
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
