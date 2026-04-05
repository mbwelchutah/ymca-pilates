import { useEffect, useState } from 'react'
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
import type { SniperState } from '../lib/readinessTypes'
import { api } from '../lib/api'
import {
  SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL,
} from '../lib/readinessResolver'
import { computeConfidence } from '../lib/confidence'
import { generateSuggestions } from '../lib/suggestions'

interface NowScreenProps {
  appState: AppState
  selectedJobId: number | null
  loading: boolean
  error: string | null
  refresh: () => void
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
 * Compute the booking-open epoch ms entirely in browser local time.
 * Rules: booking opens 3 days before the class, 1 hour before class start.
 */
function computeBookingOpenMs(job: Job): number | null {
  if (!job?.class_time || !job?.day_of_week) return null
  const time = parseClassTime(job.class_time)
  if (!time) return null
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

  const bookingOpen = new Date(nextClass)
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

// ── Static config ──────────────────────────────────────────────────────────────

const PHASE_CONFIG: Record<Phase, {
  label: string
  dotColor: 'gray' | 'amber' | 'blue' | 'green' | 'red'
  headerSubtitle: string
}> = {
  too_early: { label: 'Waiting',       dotColor: 'gray',  headerSubtitle: 'Waiting'       },
  warmup:    { label: 'Opening Soon',  dotColor: 'amber', headerSubtitle: 'Opening Soon'  },
  sniper:    { label: 'Booking Now',   dotColor: 'blue',  headerSubtitle: 'Booking Now'   },
  late:      { label: 'Window Closed', dotColor: 'red',   headerSubtitle: 'Window Closed' },
  unknown:   { label: 'Waiting',       dotColor: 'gray',  headerSubtitle: 'Waiting'       },
}

const RESULT_CONFIG: Record<string, {
  label: string
  dotColor: 'gray' | 'green' | 'amber' | 'red' | 'blue'
}> = {
  booked:             { label: 'Booked',            dotColor: 'green' },
  dry_run:            { label: 'Simulated Booking',  dotColor: 'blue'  },
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
  return `${dayName} at ${job.class_time}${job.instructor ? ` with ${job.instructor}` : ''}`
}

const STEPS = ['Waiting', 'Opening Soon', 'Booking', 'Done']
const PHASE_STEP: Record<Phase, number> = {
  too_early: 0, warmup: 1, sniper: 2, late: 2, unknown: 0,
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
  if (value === 'SESSION_EXPIRED') return 'amber'
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
    case 'SNIPER_BLOCKED_ACTION':    return 'Booking action unavailable'
    default: return null
  }
}

// ── Readiness row sub-component ────────────────────────────────────────────────

function ReadinessRow({
  label, value, dotColor, last,
}: {
  label: string
  value: string
  dotColor: DotColor
  last?: boolean
}) {
  return (
    <div className={`flex items-center justify-between px-4 py-3 ${!last ? 'border-b border-divider' : ''}`}>
      <span className="text-[14px] text-text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        <StatusDot color={dotColor} />
        <span className="text-[14px] font-medium text-text-primary">{value}</span>
      </div>
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
    case 'FAMILYWORKS_SESSION_MISSING': return { label: 'Expired', dotColor: 'amber' }
    default:                            return { label: 'Unknown', dotColor: 'gray'  }
  }
}

function sniperToLabel(
  sniperState: SniperState | null | undefined,
  locked: boolean,
): { label: string; dotColor: DotColor } {
  if (locked) return { label: 'Booking', dotColor: 'blue' }
  switch (sniperState) {
    case 'SNIPER_READY':             return { label: 'Ready',      dotColor: 'green' }
    case 'SNIPER_ARMED':             return { label: 'Armed',      dotColor: 'blue'  }
    case 'SNIPER_BOOKING':
    case 'SNIPER_CONFIRMING':        return { label: 'Booking',    dotColor: 'blue'  }
    case 'SNIPER_BLOCKED_AUTH':
    case 'SNIPER_BLOCKED_DISCOVERY':
    case 'SNIPER_BLOCKED_ACTION':    return { label: 'Blocked',    dotColor: 'red'   }
    case 'SNIPER_RECOVERY_ACTIVE':   return { label: 'Recovering', dotColor: 'amber' }
    case 'SNIPER_WAITING':           return { label: 'Waiting',    dotColor: 'gray'  }
    default:                         return { label: 'Unknown',    dotColor: 'gray'  }
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
  sessionStatus, bundleSession, sniperState, verifying, onVerify,
}: {
  sessionStatus: SessionStatus | null
  bundleSession: string
  sniperState:   SniperState | null
  verifying:     boolean
  onVerify:      () => void
}) {
  const locked = sessionStatus?.locked ?? false

  // Session (daxko) — always show real auth state; fall back to sniper bundle
  const sessionLabel = sessionStatus
    ? daxkoToLabel(sessionStatus.daxko)
    : { label: SESSION_LABEL[bundleSession as keyof typeof SESSION_LABEL] ?? '—', dotColor: readinessDotColor(bundleSession) as DotColor }

  // Schedule access (familyworks) — always show real state
  const fwLabel = sessionStatus
    ? fwToLabel(sessionStatus.familyworks)
    : { label: '—', dotColor: 'gray' as DotColor }

  // Sniper — locked state overrides to "Booking"
  const snLabel = sniperToLabel(sniperState, locked)

  // Last verified as absolute timestamp
  const lastVerified = formatAbsoluteTime(sessionStatus?.lastVerified ?? null)

  // Trust line — all three green and no active booking
  const allGreen =
    sessionStatus?.daxko        === 'DAXKO_READY'            &&
    sessionStatus?.familyworks  === 'FAMILYWORKS_READY'       &&
    snLabel.dotColor !== 'red'                                &&
    !locked

  const verifyDisabled = verifying || locked

  return (
    <>
      {/* Session row */}
      <div className="border-b border-divider px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Session</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onVerify}
              disabled={verifyDisabled}
              className={`text-[12px] font-medium px-2 py-0.5 rounded-md transition-opacity
                ${verifyDisabled
                  ? 'text-text-muted bg-divider opacity-60'
                  : 'text-accent-blue bg-accent-blue/10 active:opacity-70'
                }`}
            >
              {verifying ? 'Verifying…' : 'Verify'}
            </button>
            <StatusDot color={verifying ? 'gray' : sessionLabel.dotColor} />
            <span className="text-[14px] font-medium text-text-primary">
              {verifying ? 'Checking…' : sessionLabel.label}
            </span>
          </div>
        </div>
      </div>

      {/* Schedule access row */}
      <div className="border-b border-divider px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Schedule access</span>
          <div className="flex items-center gap-2">
            <StatusDot color={verifying ? 'gray' : fwLabel.dotColor} />
            <span className="text-[14px] font-medium text-text-primary">
              {verifying ? '—' : fwLabel.label}
            </span>
          </div>
        </div>
      </div>

      {/* Sniper row */}
      <div className="border-b border-divider px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-text-secondary">Sniper</span>
          <div className="flex items-center gap-2">
            <StatusDot color={snLabel.dotColor} />
            <span className="text-[14px] font-medium text-text-primary">{snLabel.label}</span>
          </div>
        </div>
      </div>

      {/* Last verified row */}
      <div className={`px-4 py-3 flex items-center justify-between ${allGreen ? 'border-b border-divider' : ''}`}>
        <span className="text-[14px] text-text-secondary">Last verified</span>
        <span className="text-[14px] font-medium text-text-primary">{lastVerified}</span>
      </div>

      {/* Optional trust line — shown only when everything is green */}
      {allGreen && (
        <div className="px-4 py-2.5">
          <p className="text-[12px] text-accent-green text-right">Ready for the next booking window</p>
        </div>
      )}
    </>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export function NowScreen({ appState, selectedJobId, loading, error, refresh }: NowScreenProps) {
  const job = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null

  const bookingOpenMs = job ? computeBookingOpenMs(job) : null
  const warmupMs      = bookingOpenMs ? bookingOpenMs - 10 * 60 * 1000 : null
  const phase: Phase  = computePhase(bookingOpenMs)

  const cfg      = PHASE_CONFIG[phase]
  const countdown = useCountdown(bookingOpenMs)
  const stepIdx  = PHASE_STEP[phase]
  const isBooked = isBookingCurrentCycle(job)
  const isStaleBooking =
    (job?.last_result === 'booked' || job?.last_result === 'dry_run') && !isBooked

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

  // ── Dedicated session check state ──────────────────────────────────────────
  const [sessionStatus,   setSessionStatus]   = useState<SessionStatus | null>(null)
  const [sessionChecking, setSessionChecking] = useState(false)

  useEffect(() => {
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
  }, [])

  const handleVerifySession = async () => {
    if (sessionChecking) return
    setSessionChecking(true)
    try {
      await api.checkSession()
      // Re-fetch full status so overall/lastVerified fields are populated
      const full = await api.getSessionStatus()
      setSessionStatus(full)
    } catch { /* swallow — UI shows previous status */ }
    finally { setSessionChecking(false) }
  }

  const bundle  = sniperRunState?.bundle
  const blocked = blockedReason(sniperRunState, sessionStatus)

  // Auth issues show amber; discovery/action blocks show red.
  const blockedIsAuthWarn =
    sessionStatus?.overall === 'AUTH_NEEDS_LOGIN'            ||
    sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING' ||
    sniperRunState?.sniperState === 'SNIPER_BLOCKED_AUTH'

  // ── Confidence score (Stage 9.1) ───────────────────────────────────────────
  // Computed entirely from data already fetched — no new API calls.
  const confidence = computeConfidence(
    bundle ?? { session: 'SESSION_UNKNOWN', discovery: 'DISCOVERY_NOT_TESTED', action: 'ACTION_NOT_TESTED' },
    sessionStatus,
    sniperRunState?.events ?? [],
    sniperRunState?.updatedAt ?? null,
  )

  // ── Suggestions (Stage 9.5) — high-priority only, max 1 on Now ─────────────
  const nowSuggestion = generateSuggestions({
    sessionValid:    sessionStatus?.valid ?? null,
    sniperState:     sniperRunState?.sniperState ?? null,
    confidenceScore: confidence.score,
  }).filter(s => s.priority === 'high')[0] ?? null

  // True only when there's useful readiness data (at least one dimension is not in the default "unknown/not tested" state)
  const hasReadinessData = bundle && (
    bundle.session   !== 'SESSION_UNKNOWN'       ||
    bundle.discovery !== 'DISCOVERY_NOT_TESTED'  ||
    bundle.action    !== 'ACTION_NOT_TESTED'
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
  type PreflightResult = { label: string; color: 'green' | 'amber' | 'red' | 'gray' }

  function mapPreflightResult(result: {
    success: boolean
    status: string
    message: string
    sniperState: SniperRunState | null
  }): PreflightResult {
    const ss = result.sniperState?.sniperState
    if (ss === 'SNIPER_READY')             return { label: 'Preflight passed',              color: 'green' }
    if (ss === 'SNIPER_BLOCKED_AUTH')      return { label: 'Login required',                color: 'amber' }
    if (ss === 'SNIPER_BLOCKED_DISCOVERY') return { label: 'Class not found',               color: 'red'   }
    if (ss === 'SNIPER_BLOCKED_ACTION')    return { label: 'Action blocked',                color: 'red'   }
    if (ss === 'SNIPER_WAITING')           return { label: 'Not open yet',                  color: 'gray'  }
    // Fall back to status field
    if (result.status === 'success')            return { label: 'Preflight passed',         color: 'green' }
    if (result.status === 'found_not_open_yet') return { label: 'Not open yet',             color: 'gray'  }
    if (result.status === 'not_found')          return { label: 'Class not found',          color: 'red'   }
    if (result.status === 'auth_failed')        return { label: 'Login required',           color: 'amber' }
    if (result.status === 'locked')             return { label: 'System busy — try later',  color: 'gray'  }
    if (result.message?.toLowerCase().includes('lock')) return { label: 'System busy — try later', color: 'gray' }
    if (result.message?.toLowerCase().includes('session')) return { label: 'Session expired', color: 'amber' }
    if (result.message?.toLowerCase().includes('modal')) return { label: 'Modal issue',     color: 'red'   }
    return { label: 'Check failed',   color: 'red' }
  }

  const [preflightRunning, setPreflightRunning] = useState(false)
  const [preflightResult,  setPreflightResult]  = useState<PreflightResult | null>(null)

  const handleCheckNow = async () => {
    if (!job || preflightRunning || sessionStatus?.locked) return
    setPreflightRunning(true)
    setPreflightResult(null)
    try {
      const result = await api.runPreflight(job.id)
      if (result.sniperState) setSniperRunState(result.sniperState)
      setPreflightResult(mapPreflightResult(result))
    } catch { setPreflightResult({ label: 'Check failed', color: 'red' }) }
    finally { setPreflightRunning(false) }
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
        subtitle={cfg.headerSubtitle + (appState.dryRun ? ' · Simulation' : '')}
      />

      <ScreenContainer>
        {/* ── Hero card ──────────────────────────────────────────── */}
        <Card padding="md">
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
            <div className="mb-3">
              <p className="text-[22px] font-semibold text-text-primary">No class selected</p>
              <p className="text-[13px] text-text-secondary mt-1">
                Add a class in the Plan tab to start watching
              </p>
            </div>
          )}

          {/* Status banner — booked / sniper / late / countdown */}
          {isBooked ? (
            <div className="bg-accent-green/10 rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="green" />
              <span className="text-[17px] font-semibold text-accent-green">
                {job?.last_result === 'dry_run' ? 'Simulated Booking' : 'Booked'}
              </span>
            </div>
          ) : phase === 'sniper' ? (
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
          ) : (
            <div className="bg-surface rounded-xl px-4 py-3 flex items-baseline gap-2">
              <span className="text-[42px] font-bold text-text-primary tabular-nums leading-none tracking-tighter">
                {countdown || '—'}
              </span>
              <span className="text-[14px] text-text-secondary font-medium">until window opens</span>
            </div>
          )}

          {/* Inline blocked callout — surfaces the most critical issue without scrolling */}
          {blocked && (
            <div className={`mt-3 rounded-xl px-3.5 py-2.5 ${blockedIsAuthWarn ? 'bg-accent-amber/10' : 'bg-accent-red/10'}`}>
              <p className={`text-[13px] font-medium ${blockedIsAuthWarn ? 'text-accent-amber' : 'text-accent-red'}`}>
                {blocked}
              </p>
            </div>
          )}

          {/* Check Now button + inline result */}
          {job && (
            <div className="mt-3 pt-3 border-t border-divider">
              <button
                onClick={handleCheckNow}
                disabled={preflightRunning || (sessionStatus?.locked ?? false)}
                className={`w-full py-2.5 rounded-xl text-[15px] font-semibold transition-opacity
                  ${preflightRunning || (sessionStatus?.locked ?? false)
                    ? 'bg-divider text-text-muted opacity-60'
                    : 'bg-accent-blue/10 text-accent-blue active:opacity-70'
                  }`}
              >
                {preflightRunning ? 'Checking…' : 'Check Now'}
              </button>

              {/* Concise result — shown after Check Now completes */}
              {preflightResult && !preflightRunning && (
                <p className={`mt-2 text-center text-[13px] font-medium
                  ${preflightResult.color === 'green' ? 'text-accent-green' :
                    preflightResult.color === 'amber' ? 'text-accent-amber' :
                    preflightResult.color === 'red'   ? 'text-accent-red'   :
                    'text-text-muted'}
                `}>
                  {preflightResult.label}
                </p>
              )}
            </div>
          )}
        </Card>

        {/* ── Progress steps ─────────────────────────────────────── */}
        <Card padding="none">
          <div className="px-5 pt-4 pb-5">
            {/* Progress label + confidence score on one line */}
            <div className="flex items-center justify-between mb-3">
              <p className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
                Progress
              </p>
              <span className={`text-[12px] font-semibold tabular-nums ${
                confidence.score >= 80 ? 'text-accent-green' :
                confidence.score >= 60 ? 'text-accent-amber' :
                'text-text-muted'
              }`}>
                {confidence.score}%
              </span>
            </div>

            <div className="flex items-center gap-1">
              {STEPS.map((step, i) => {
                // If the phase is `late` and the user is booked, treat Done (index 3)
                // as the effective step so the bar reaches "Done" green.
                const effectiveStepIdx = (phase === 'late' && isBooked) ? 3 : stepIdx
                const done    = i < effectiveStepIdx || (isBooked && i === effectiveStepIdx)
                const current = i === effectiveStepIdx && !isBooked
                // late + not booked: the window closed without a booking.
                // Show the current step (Booking) muted, not blue, so it reads
                // as "window passed" rather than "actively booking".
                const windowMissed = current && phase === 'late'
                const future  = !done && !current
                return (
                  <div key={step} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className={`
                      h-1.5 w-full rounded-pill
                      ${done         ? 'bg-accent-green' : ''}
                      ${current && !windowMissed ? 'bg-accent-blue'  : ''}
                      ${current &&  windowMissed ? 'bg-divider'      : ''}
                      ${future       ? 'bg-divider'       : ''}
                    `} />
                    <span className={`
                      text-[10px] font-medium text-center leading-tight
                      ${done         ? 'text-accent-green' : ''}
                      ${current && !windowMissed ? 'text-accent-blue' : ''}
                      ${current &&  windowMissed ? 'text-text-muted'  : ''}
                      ${future       ? 'text-text-muted'   : ''}
                    `}>
                      {step}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Confidence explanation — muted footnote below the bars */}
            <p className="text-[11px] text-text-muted mt-2.5 leading-snug">
              {confidence.explanation}
            </p>
          </div>
        </Card>

        {/* ── Readiness ──────────────────────────────────────────── */}
        {(bundle || sessionStatus) && (
          <>
            <SectionHeader title="Readiness" />
            <Card padding="none">
              {/* Account & Session block — Session + Schedule access rows + timestamp */}
              <AccountSessionBlock
                sessionStatus={sessionStatus}
                bundleSession={bundle?.session ?? 'SESSION_UNKNOWN'}
                sniperState={sniperRunState?.sniperState ?? null}
                verifying={sessionChecking}
                onVerify={handleVerifySession}
              />
              {/* Discovery + Action rows — only shown when sniper has data */}
              {hasReadinessData ? (
                <>
                  <ReadinessRow
                    label="Discovery"
                    value={DISCOVERY_LABEL[bundle!.discovery] ?? bundle!.discovery}
                    dotColor={readinessDotColor(bundle!.discovery)}
                  />
                  <ReadinessRow
                    label="Action"
                    value={ACTION_LABEL[bundle!.action] ?? bundle!.action}
                    dotColor={readinessDotColor(bundle!.action)}
                    last
                  />
                </>
              ) : (
                <div className="px-4 py-3 pb-3">
                  <p className="text-[12px] text-text-muted">Run Preflight Check in Tools to test discovery &amp; action</p>
                </div>
              )}
            </Card>
          </>
        )}

        {/* ── Suggestion hint (Stage 9.5) — high-priority only ── */}
        {nowSuggestion && (
          <div className="flex items-start gap-2 px-1 py-0.5">
            <span className="text-[13px] flex-shrink-0 mt-0.5">💡</span>
            <p className="text-[12px] text-text-secondary leading-snug">
              {nowSuggestion.text}
            </p>
          </div>
        )}

        {/* ── Action row ─────────────────────────────────────────── */}
        <SecondaryButton onClick={handlePauseResume} className="w-full">
          {appState.schedulerPaused ? 'Resume Scheduler' : 'Pause Scheduler'}
        </SecondaryButton>

        {isStaleBooking && job && (
          <SecondaryButton
            onClick={handleBookAgain}
            disabled={resetting}
            className="w-full"
          >
            {resetting ? 'Resetting…' : 'Book again'}
          </SecondaryButton>
        )}

        {/* ── Booking Window ─────────────────────────────────────── */}
        {bookingOpenMs && (
          <>
            <SectionHeader title="Booking Window" />
            <Card padding="none">
              <DetailRow label="Opens"  value={fmtWithRelative(bookingOpenMs)} />
              <DetailRow label="Warmup" value={warmupMs ? fmtWithRelative(warmupMs) : '—'} last />
            </Card>
          </>
        )}

        {/* ── Details ────────────────────────────────────────────── */}
        {job && (
          <>
            <SectionHeader title="Details" />
            <Card padding="none">
              <DetailRow
                label="Status"
                value={job.last_result
                  ? (RESULT_CONFIG[job.last_result]?.label ?? job.last_result)
                  : 'No runs yet'}
              />
              <DetailRow
                label="Last Run"
                value={job.last_run_at
                  ? new Date(job.last_run_at).toLocaleString([], {
                      month: 'short', day: 'numeric',
                      hour: 'numeric', minute: '2-digit',
                    })
                  : '—'}
              />
              <ToggleRow
                label="Simulation Mode"
                value={appState.dryRun}
                onChange={handleDryRun}
              />
            </Card>
          </>
        )}

        {/* ── Simulation mode notice ─────────────────────────────── */}
        {appState.dryRun && (
          <Card padding="sm" className="border border-accent-amber/30 bg-accent-amber/5">
            <p className="text-[13px] text-accent-amber font-medium">
              Simulation mode is on — bookings won't actually register.
            </p>
          </Card>
        )}
      </ScreenContainer>
    </>
  )
}
