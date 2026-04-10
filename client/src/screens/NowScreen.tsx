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
import { computeArmedModel } from '../lib/sniperArmed'
import type { ArmedModel } from '../lib/sniperArmed'
import { deriveSniperPhase } from '../lib/sniperPhase'
import type { SniperPhase } from '../lib/sniperPhase'
import { isThisWeekUTC } from '../lib/bookingCycle'
import { useCountdown } from '../lib/countdown'
import { formatOpens, formatOpensRelative } from '../lib/timing'

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
  polledStatus?: SessionStatus | null
  onDismissEscalation?: (jobId: number) => void
  bgRefreshSignal?: number
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
  blocked:          string | null
  bgSession?:       string | null
  bgDiscovery?:     string | null
  bgModal?:         string | null
}): PrimaryResult {
  const {
    isBooked, isInactive, job,
    phase,
    sessionStatus,
    composite, compositeDetail, showComposite,
    bookingActive, lastPreflightAt, bgArmedState, blocked,
    bgSession, bgDiscovery, bgModal,
  } = opts

  // ── STATE: booking ─────────────────────────────────────────────────────────
  // Active booking attempt is in progress right now.
  // Stage 1: only trigger on real booking runs (jobState.active via armed.state),
  //          never on preflight, verify, or background checks.
  // Stage 2: window must be open (phase === 'sniper') — no booking before open time.
  if (bookingActive && phase === 'sniper') {
    return {
      state:    'booking',
      label:    'Booking…',
      detail:   'Attempting registration now.',
      severity: 'info',
    }
  }

  // ── STATE: success ─────────────────────────────────────────────────────────
  // Booking confirmed for this cycle.
  if (isBooked) {
    const isDryRun = job?.last_result === 'dry_run'
    return {
      state:    'success',
      label:    isDryRun ? 'Test run' : 'Confirmed',
      detail:   isDryRun
        ? 'Test mode — class found and action verified. Switch to Live to actually register.'
        : 'Registration confirmed.',
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
      label:    'Issue',
      detail:   isExpired
        ? 'Session expired — tap the account icon to sign in again'
        : 'Login required — tap the account icon to sign in',
      severity: 'error',
    }
  }

  // Job disabled — user needs to re-enable it.
  if (isInactive) {
    return {
      state:    'issue',
      label:    'Scheduling off',
      detail:   'This class is paused. Enable it in the Plan tab to resume.',
      severity: 'muted',
    }
  }

  // Auto-check or composite signals a real problem (red = blocking error).
  if (bgArmedState === 'needs_attention') {
    let detail: string
    let label = 'Issue'
    if (bgDiscovery === 'missing') {
      detail = 'Class not found on the schedule — will check again before the window opens.'
    } else if (bgModal === 'blocked') {
      detail = 'Booking link not accessible — retrying automatically.'
    } else if (bgSession === 'error') {
      detail = 'Sign-in check timed out — the bot is retrying. Tap the account icon if this persists.'
    } else {
      label  = 'Checking'
      detail = 'A recent preflight timed out — retrying automatically. No action needed.'
    }
    return {
      state:    'issue',
      label,
      detail,
      severity: 'warning',
    }
  }
  if (showComposite && composite.color === 'red') {
    return {
      state:    'issue',
      label:    'Issue',
      detail:   compositeDetail,
      severity: 'error',
      ts:       lastPreflightAt ?? undefined,
    }
  }

  // ── STATE: issue (sniper block — residual) ─────────────────────────────────
  // Catches SNIPER_BLOCKED_AUTH / SNIPER_BLOCKED_DISCOVERY when neither auth
  // errors, inactive state, bgArmedState, nor composite-red fired above.
  if (blocked) {
    return {
      state:    'issue',
      label:    'Issue',
      detail:   blocked,
      severity: 'warning',
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
      label:    'Armed',
      detail:   'Everything is ready for the booking window.',
      severity: 'success',
      ts:       lastPreflightAt ?? undefined,
    }
  }

  // ── STATE: waiting ─────────────────────────────────────────────────────────
  // No problem detected. Window not open yet. System is monitoring.
  // Consolidates: not checked, checked-waiting, warmup, late, stale, amber composite.
  // "Scheduled" matches Plan's PHASE_LABEL for too_early/unknown — canonical term.
  return {
    state:    'waiting',
    label:    'Scheduled',
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
  too_early: { label: 'Scheduled'     }, // matches Plan's PHASE_LABEL — canonical term
  warmup:    { label: 'Opens Soon'    }, // matches Plan's PHASE_LABEL warmup exactly
  sniper:    { label: 'Booking…'      }, // matches canonical vocabulary (ellipsis = in-progress)
  late:      { label: 'Window Closed' },
  unknown:   { label: 'Scheduled'     }, // matches Plan's PHASE_LABEL unknown
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

function isBookingCurrentCycle(job: Job | null): boolean {
  if (!job) return false
  // Accept both 'booked' (new) and 'success' (legacy DB records) as confirmed.
  const isConfirmed = job.last_result === 'booked' || job.last_result === 'success' || job.last_result === 'dry_run'
  if (!isConfirmed) return false
  if (job.target_date) {
    const today = new Date().toLocaleDateString('en-CA')
    return job.target_date >= today
  }
  return isThisWeekUTC(job.last_success_at)
}

// ── Readiness helpers ──────────────────────────────────────────────────────────

type DotColor = 'green' | 'gray' | 'red' | 'amber' | 'blue'

// Derives a single concise string that describes the current blocker (if any).
function blockedReason(s: SniperRunState | null, sessionStatus: SessionStatus | null): string | null {
  // Suppress auth messages when a booking/auth operation is actively running —
  // the lock being held is not itself an auth failure.
  if (sessionStatus?.locked) return null
  // Settings session state takes priority over sniper signals.
  // Always use canonical messages — raw session.detail may be a technical string.
  if (sessionStatus?.overall === 'AUTH_NEEDS_LOGIN')            return 'Login required — tap the account icon to sign in'
  if (sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING') return 'Session expired — tap the account icon to sign in again'
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

// ── Component ──────────────────────────────────────────────────────────────────

export function NowScreen({ appState, selectedJobId, loading, error, refresh, onGoToTools, onAccount, accountAttention, authStatus, polledStatus, onDismissEscalation, bgRefreshSignal }: NowScreenProps) {
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
  //   isBooked          → banner shows "Confirmed"
  //   isInactive        → banner shows "Scheduling off"
  //   phase === 'sniper'         → banner shows "Booking in progress…"
  //   execPhase === 'confirming' → banner shows "Confirming registration…"
  //   phase === 'late'           → banner shows "Booking window has closed"
  //     Without this, the result card falls through to "Scheduled · Booking will
  //     start automatically when the window opens." — directly contradicting the
  //     "window has closed" banner.  Session-attention errors still surface via the
  //     dedicated nudge below (which is outside the bannerIsComplete gate).
  const bannerIsComplete =
    isBooked || isInactive || phase === 'sniper' || execPhase === 'confirming' ||
    phase === 'late'

  // The effect re-runs whenever readinessPollMs changes so the interval is
  // always in sync with the current execution phase.
  useEffect(() => {
    api.getReadiness().then(setBgReadiness).catch(() => {})
    const id = setInterval(() => api.getReadiness().then(setBgReadiness).catch(() => {}), readinessPollMs)
    return () => clearInterval(id)
  }, [readinessPollMs])

  // Imperative refresh — parent bumps bgRefreshSignal to force an immediate re-fetch
  // (used after dismiss escalation so the banner clears without waiting for the next poll).
  useEffect(() => {
    if (!bgRefreshSignal) return
    api.getReadiness().then(setBgReadiness).catch(() => {})
  }, [bgRefreshSignal])

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

    // Stale readiness cleared on job switch or edit — no log needed
    setStableResult(null)          // Stage 2: reset hysteresis on job switch
    setStableConfidenceLabel(null) // Stage 4: reset label hysteresis on job switch
    api.getSniperState().then(setSniperRunState).catch(() => {})
    api.getSessionStatus().then(setLocalSessionStatus).catch(() => {})
    api.getReadiness().then(setBgReadiness).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobFingerprint])

  // ── Session status — shared auth truth ────────────────────────────────────
  // App.tsx's 90 s poll provides the base; job-switch and post-Check-Now fetches
  // override it locally when a fresher result is immediately needed.
  const [localSessionStatus, setLocalSessionStatus] = useState<SessionStatus | null>(null)
  const sessionStatus = localSessionStatus ?? polledStatus ?? null

  // Reconcile bgReadiness.session with sessionStatus for armed-model and
  // derivePrimaryResult.  bgReadiness reflects the last preflight/keepalive
  // run, which can fail with 'error' due to a network timeout even when the
  // session is genuinely active.  sessionStatus is polled independently every
  // 90 s — when it says the session is valid, a fresh bgReadiness 'error' is
  // more likely a transient network issue than a real expired session, so
  // downgrade it to 'unknown' to avoid false "Sign-in check timed out" alerts.
  const reconciledBgSession: 'ready' | 'error' | 'unknown' | null = (() => {
    const raw = isReadinessForSelectedJob ? (bgReadiness?.session ?? null) : null
    if (raw !== 'error') return raw
    const sessOk = sessionStatus?.daxko === 'DAXKO_READY' ||
                   sessionStatus?.familyworks === 'FAMILYWORKS_READY'
    return sessOk ? 'unknown' : raw
  })()

  // Stage 6 — Sniper armed model (Layer C).
  // Computed client-side from the 5 normalized readiness fields so the model is
  // independently typed and doesn't require the server's `armed` sub-object to
  // be present.  The server's `armed.nextWindow`, `watchingActive`, `autoRetry`
  // are still used as context inputs since the client can't compute them locally.
  const sniperArmed: ArmedModel | null = (() => {
    if (!isReadinessForSelectedJob || !bgReadiness) return null
    const { schedule, discovery, modal } = bgReadiness
    return computeArmedModel({
      session:  reconciledBgSession ?? 'unknown',
      schedule,
      discovery,
      modal,
      bookingActive:   bgReadiness.armed?.state === 'booking',
      nextWindow:      bgReadiness.armed?.nextWindow      ?? null,
      autoCheckActive: bgReadiness.armed?.watchingActive  ?? false,
      autoRetry:       bgReadiness.armed?.autoRetry       ?? false,
    })
  })()



  // Sniper state is global (last-run-wins).  Only treat it as applicable to the
  // current view when its jobId matches the selected job, or when the server
  // hasn't stored a jobId yet (legacy/null).
  const isReadinessForCurrentJob =
    sniperRunState?.jobId == null || sniperRunState.jobId === selectedJobId

  const bundle  = isReadinessForCurrentJob ? sniperRunState?.bundle : undefined
  const blocked = (() => {
    if (!isReadinessForCurrentJob) return null
    const raw = blockedReason(sniperRunState, sessionStatus)
    // HTTP tier-2 ping is more authoritative than Playwright-written auth state.
    // When bgReadiness confirms the session is active, suppress stale session-block messages.
    if (raw !== null && isReadinessForSelectedJob && bgReadiness?.session === 'ready') return null
    return raw
  })()


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
  // Stage 2: stable display result — applies hysteresis so the card doesn't flicker.
  const [stableResult, setStableResult] = useState<PrimaryResult | null>(null)
  // Stage 4: stable confidence label — separate hysteresis for the label so it
  // doesn't oscillate from small score changes.
  const [stableConfidenceLabel, setStableConfidenceLabel] = useState<ConfidenceLabel | null>(null)

  // ── Composite readiness (Stage 10) ─────────────────────────────────────────
  // Derived at render time from the live bundle + last preflight status.
  // Effective preflight status — prefer the current session value; fall back to
  // the persisted snapshot so the composite stays accurate across page refreshes.
  const effectivePreflightStatus =
    sniperRunState?.lastPreflightSnapshot?.status ?? null

  // Timestamp of the last user-triggered Check Now (persisted in sniper-state.json).
  const lastPreflightAt = sniperRunState?.lastPreflightSnapshot?.checkedAt ?? null

  // Reconcile bundle.session with bgReadiness.session (HTTP-ping derived).
  // The HTTP ping is more authoritative than the Playwright sniper bundle —
  // when they disagree, trust the HTTP result so the card stays consistent
  // with the green Session dot in the milestones strip below.
  const reconciledBundle = (() => {
    const b = bundle ?? DEFAULT_READINESS
    if (!isReadinessForSelectedJob) return b
    const bgSess = bgReadiness?.session
    if (bgSess === 'ready')  return { ...b, session: 'SESSION_READY'   as const }
    if (bgSess === 'error')  return { ...b, session: 'SESSION_EXPIRED' as const }
    return b
  })()

  // Replaces the old per-call mapPreflightResult() priority chain.
  const composite: CompositeReadiness = computeCompositeReadiness(
    reconciledBundle,
    effectivePreflightStatus,
    sniperRunState?.sniperState ?? null,
  )
  // Show the composite badge only when there is something meaningful to say.
  const showComposite = effectivePreflightStatus !== null || Boolean(hasReadinessData)

  // ── Stage 8: Composite detail ───────────────────────────────────────────────
  // Uses the computed composite message directly. Background-loop readiness
  // provides all necessary context without a manual preflight.
  const compositeDetail: string = composite.detail

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
    blocked,
    bgSession:    reconciledBgSession    ?? null,
    bgDiscovery:  bgReadiness?.discovery ?? null,
    bgModal:      bgReadiness?.modal     ?? null,
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
              <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mb-1.5">
                Active from Plan
              </p>
              <h2 className="text-[28px] font-bold tracking-tighter text-text-primary leading-tight">
                {job.class_title}
              </h2>
              <p className="text-[14px] text-text-secondary mt-1 mb-2">
                {formatDayTime(job)}
              </p>
            </>
          ) : (
            <div className="mb-3">
              <p className="text-[22px] font-semibold text-text-primary">No class selected</p>
              <p className="text-[13px] text-text-secondary mt-1">
                {appState.jobs.length === 0
                  ? 'Add a class in the Plan tab to get started.'
                  : 'Tap a class in the Plan tab to watch it.'}
              </p>
            </div>
          )}

          {/* Status banner — booked / off / sniper / late / countdown */}
          {isBooked ? (
            <div className="bg-accent-green/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="green" />
              <span className="text-[17px] font-semibold text-accent-green">
                {job?.last_result === 'dry_run' ? 'Test run' : 'Confirmed'}
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
          ) : phase === 'late' && bgReadiness?.armed?.state === 'booking' ? (
            // Booking is actively running during the late phase — don't prematurely
            // show "window closed" while the bot is still attempting registration.
            <div className="bg-accent-blue/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">
                Booking in progress…
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
              <span className="text-[48px] font-bold text-text-primary tabular-nums leading-none tracking-tighter">
                {countdown || '—'}
              </span>
              {bookingOpenMs != null && (
                <p className="text-[12px] text-text-muted mt-2">
                  {execPhase === 'warmup'
                    ? `Opening soon · ${formatOpensRelative(bookingOpenMs)}`
                    : formatOpens(bookingOpenMs)}
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



          {/* Actions section */}
          {job && (
            <div className="mt-2 pt-2 border-t border-divider">

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
                  <div className={`rounded-xl px-3.5 py-3 mt-2 mb-1 ${bgClass}`}>
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
              {!bannerIsComplete && (() => {
                if (!isReadinessForSelectedJob) return null

                // Steady state — Confidence · Freshness
                // State is already shown in the card above; trust line provides supporting context only.
                const result = stableResult ?? currentResult
                if (!result) return null

                const dotColor: DotColor =
                  result.severity === 'success' ? 'green' :
                  result.severity === 'error'   ? 'red'   :
                  result.severity === 'warning' ? 'amber' :
                  result.severity === 'info'    ? 'blue'  :
                  'gray'

                // Map confidence: low confidence on an issue → "At risk"
                const confText = (() => {
                  if (!confidenceLabel) return null
                  if (result.state === 'issue' && confidenceLabel === 'Low confidence') return 'At risk'
                  return confidenceLabel
                })()

                const trustText = [confText, lastCheckedText].filter(Boolean).join(' · ')
                if (!trustText) return null

                return (
                  <div className="mb-2 flex items-center justify-center gap-1.5">
                    <StatusDot color={dotColor} size="sm" />
                    <span className="text-[12px] text-text-muted">
                      {trustText}
                    </span>
                  </div>
                )
              })()}


              {/* ── Bottom utility row: Live/Test toggle + Pause/Resume ───────────── */}
              {/* Resume is shown as an amber pill (urgent); Pause is muted text.    */}
              {/* Live/Test is always visible; Pause/Resume only when banner active.  */}
              <div className="flex items-center justify-between mt-2 px-1">
                {/* Live / Test toggle — left side */}
                <div className="flex items-center gap-0.5 text-[12px]">
                  <button
                    onClick={() => handleDryRun(false)}
                    className={`px-2 py-1 rounded-md transition-all
                      ${!appState.dryRun
                        ? 'bg-surface font-semibold text-text-primary'
                        : 'text-text-muted'}`}
                  >
                    Live
                  </button>
                  <span className="text-text-muted opacity-30 select-none">/</span>
                  <button
                    onClick={() => handleDryRun(true)}
                    className={`px-2 py-1 rounded-md transition-all
                      ${appState.dryRun
                        ? 'bg-surface font-semibold text-text-primary'
                        : 'text-text-muted'}`}
                  >
                    Test
                  </button>
                </div>

                {/* Pause / Resume — right side, only when banner is active */}
                {!bannerIsComplete && (
                  appState.schedulerPaused ? (
                    <button
                      onClick={handlePauseResume}
                      className="px-4 py-1.5 rounded-full text-[12px] font-semibold text-accent-amber bg-accent-amber/10 active:opacity-70 transition-opacity"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      onClick={handlePauseResume}
                      className="text-[12px] text-text-muted active:opacity-50 py-1 px-2"
                    >
                      Pause
                    </button>
                  )
                )}
              </div>

            </div>
          )}
        </Card>

        {/* Stage 5 — Session attention nudge ───────────────────────────
             Shown only when accountAttention is true (explicit known-failure:
             AUTH_NEEDS_LOGIN or FAMILYWORKS_SESSION_MISSING). No dismiss —
             it disappears naturally once the session is fixed.              */}
        {accountAttention &&
          !(isReadinessForSelectedJob && bgReadiness?.session === 'ready') &&
          sessionStatus?.daxko        !== 'DAXKO_READY' &&
          sessionStatus?.familyworks  !== 'FAMILYWORKS_READY' && (
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
              {job && onDismissEscalation && (
                <button
                  onClick={() => onDismissEscalation(job.id)}
                  className="flex-shrink-0 p-1 -mr-1 rounded-lg text-accent-amber/60 hover:text-accent-amber active:opacity-50 transition-opacity"
                  aria-label="Dismiss"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              )}
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

      </ScreenContainer>
    </>
  )
}
