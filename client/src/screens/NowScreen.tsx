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
import { computeConfidence } from '../lib/confidence'
import { generateSuggestions } from '../lib/suggestions'

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
    case 'FAMILYWORKS_SESSION_MISSING': return { label: 'Missing', dotColor: 'amber' }
    case 'FAMILYWORKS_SESSION_EXPIRED': return { label: 'Expired', dotColor: 'amber' }
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
  const warmupMs      = bookingOpenMs ? bookingOpenMs - 10 * 60 * 1000 : null
  const phase: Phase  = computePhase(bookingOpenMs)

  const cfg      = PHASE_CONFIG[phase]
  const countdown = useCountdown(bookingOpenMs)
  const stepIdx  = PHASE_STEP[phase]
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
    setDryRunResult(null)
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
  const [dryRunRunning,   setDryRunRunning]   = useState(false)
  const [dryRunResult,    setDryRunResult]    = useState<VerifyResult | null>(null)

  useEffect(() => {
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
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
        setVerifyResult({ label: checkResult.label ?? 'Session ready', color: 'green', detail: 'Daxko confirmed — run Check Now for full readiness' })
      }
    } catch {
      setVerifyResult({ label: 'Verification failed', color: 'red', detail: 'Check failed — try again' })
    } finally { setSessionChecking(false) }
  }

  const handleRunDryRun = async () => {
    if (!job || dryRunRunning || (sessionStatus?.locked ?? false)) return
    setDryRunRunning(true)
    setDryRunResult(null)
    try {
      const r = await api.runDryRun(job.id)
      setDryRunResult({ label: r.label, color: r.color, detail: r.message ?? '' })
      // Refresh sniper-state so Tools timeline updates.
      api.getSniperState().then(setSniperRunState).catch(() => {})
    } catch {
      setDryRunResult({ label: 'Dry run failed', color: 'red', detail: 'An error occurred — check Tools for details' })
    } finally { setDryRunRunning(false) }
  }

  // Sniper state is global (last-run-wins).  Only treat it as applicable to the
  // current view when its jobId matches the selected job, or when the server
  // hasn't stored a jobId yet (legacy/null).
  const isReadinessForCurrentJob =
    sniperRunState?.jobId == null || sniperRunState.jobId === selectedJobId

  const bundle  = isReadinessForCurrentJob ? sniperRunState?.bundle : undefined
  const blocked = isReadinessForCurrentJob ? blockedReason(sniperRunState, sessionStatus) : null

  // Auth issues show amber; discovery/action blocks show red.
  const blockedIsAuthWarn =
    sessionStatus?.overall === 'AUTH_NEEDS_LOGIN'            ||
    sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING' ||
    (isReadinessForCurrentJob && sniperRunState?.sniperState === 'SNIPER_BLOCKED_AUTH')

  // ── Confidence score (Stage 9.1) ───────────────────────────────────────────
  // Computed entirely from data already fetched — no new API calls.
  const confidence = computeConfidence(
    bundle ?? { session: 'SESSION_UNKNOWN', discovery: 'DISCOVERY_NOT_TESTED', action: 'ACTION_NOT_TESTED' },
    sessionStatus,
    isReadinessForCurrentJob ? (sniperRunState?.events ?? []) : [],
    isReadinessForCurrentJob ? (sniperRunState?.updatedAt ?? null) : null,
  )

  // ── Suggestions (Stage 9.5) — high-priority only, max 1 on Now ─────────────
  const nowSuggestion = generateSuggestions({
    sessionValid:    sessionStatus?.valid ?? null,
    sniperState:     isReadinessForCurrentJob ? (sniperRunState?.sniperState ?? null) : null,
    confidenceScore: confidence.score,
  }).filter(s => s.priority === 'high')[0] ?? null

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
    } catch { setPreflightStatus('error') }
    finally { setPreflightRunning(false) }
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
        const suffix = match ? ` · ${match.length > 36 ? match.slice(0, 36) + '…' : match}` : ''
        return `Waitlist available — class is full${suffix}`
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
        return actionDetail?.detail ?? composite.detail

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
        subtitle={
          isInactive
            ? 'Off' + (appState.dryRun ? ' · Test mode' : '')
            : cfg.headerSubtitle + (appState.dryRun ? ' · Test mode' : '')
        }
      />

      <ScreenContainer>
        {/* ── Hero card ──────────────────────────────────────────── */}
        <Card padding="md">
          {/* Status indicator row — dot only; Paused badge when scheduler is halted */}
          <div className="flex items-center gap-2 mb-3">
            <StatusDot color={isInactive ? 'gray' : cfg.dotColor} />
            <span className="text-[13px] font-medium text-text-secondary">
              {isInactive ? 'Off' : cfg.label}
            </span>
            {appState.schedulerPaused && !isInactive && (
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
          ) : phase === 'late' ? (
            <div className="bg-surface rounded-xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="gray" />
              <span className="text-[16px] text-text-secondary">Booking window has closed</span>
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
                  Opens {fmt(bookingOpenMs)}
                </p>
              )}
            </div>
          )}

          {/* Inline blocked callout — suppressed when job is inactive (not scheduled) */}
          {blocked && !isInactive && (
            <div className={`mt-3 rounded-xl px-3.5 py-2.5 ${blockedIsAuthWarn ? 'bg-accent-amber/10' : 'bg-accent-red/10'}`}>
              <p className={`text-[13px] font-medium ${blockedIsAuthWarn ? 'text-accent-amber' : 'text-accent-red'}`}>
                {blocked}
              </p>
            </div>
          )}

          {/* Run Check action + mode selector + secondary actions */}
          {job && (
            <div className="mt-3 pt-3 border-t border-divider">

              {/* Mode selector: Test / Live */}
              <div className="flex items-center bg-surface rounded-xl p-0.5 mb-2.5">
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

              {/* Primary action */}
              <button
                onClick={handleCheckNow}
                disabled={preflightRunning || (sessionStatus?.locked ?? false)}
                className={`w-full py-2.5 rounded-xl text-[15px] font-semibold transition-opacity flex items-center justify-center gap-2
                  ${preflightRunning || (sessionStatus?.locked ?? false)
                    ? 'bg-divider text-text-muted opacity-60'
                    : 'bg-accent-blue/10 text-accent-blue active:opacity-70'
                  }`}
              >
                {preflightRunning && (
                  <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                )}
                {preflightRunning ? 'Checking…' : 'Run Check'}
              </button>

              {/* Secondary action: Refresh Session */}
              {!(sessionStatus?.locked ?? false) && !preflightRunning && (
                <div className="mt-2">
                  <button
                    onClick={handleVerifySession}
                    disabled={sessionChecking}
                    className="w-full py-2 rounded-xl text-[13px] font-medium border border-divider text-text-secondary active:opacity-60 disabled:opacity-40 flex items-center justify-center gap-1.5"
                  >
                    {sessionChecking && (
                      <svg className="animate-spin h-3 w-3 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    )}
                    {sessionChecking ? 'Refreshing…' : 'Refresh Session'}
                  </button>
                </div>
              )}

              {/* Refresh Session result badge — shown after check completes */}
              {verifyResult && !sessionChecking && !preflightRunning && (
                <div className={`mt-2 rounded-xl px-3.5 py-2.5
                  ${verifyResult.color === 'green' ? 'bg-accent-green/10' :
                    verifyResult.color === 'amber' ? 'bg-accent-amber/10' :
                    'bg-accent-red/10'}
                `}>
                  <div className="flex items-center gap-2">
                    <StatusDot color={verifyResult.color} />
                    <span className={`text-[14px] font-semibold
                      ${verifyResult.color === 'green' ? 'text-accent-green' :
                        verifyResult.color === 'amber' ? 'text-accent-amber' :
                        'text-accent-red'}
                    `}>
                      {verifyResult.label}
                    </span>
                  </div>
                  <p className="text-[12px] text-text-muted mt-0.5 ml-5">{verifyResult.detail}</p>
                </div>
              )}

              {/* Lock indicator — shown when a booking is actively running */}
              {(sessionStatus?.locked ?? false) && !preflightRunning && (
                <div className="mt-2 flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-3.5 w-3.5 text-accent-blue flex-shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  <span className="text-[13px] font-medium text-accent-blue">Booking in progress</span>
                </div>
              )}

              {/* Composite readiness badge — shown after Check Now or when live data exists */}
              {showComposite && !preflightRunning && (
                <div className={`mt-2 rounded-xl px-3.5 py-2.5
                  ${composite.color === 'green' ? 'bg-accent-green/10' :
                    composite.color === 'amber' ? 'bg-accent-amber/10' :
                    composite.color === 'red'   ? 'bg-accent-red/10'   :
                    'bg-surface'}
                `}>
                  <div className="flex items-center gap-2">
                    <StatusDot color={composite.color} />
                    <span className={`text-[15px] font-semibold
                      ${composite.color === 'green' ? 'text-accent-green' :
                        composite.color === 'amber' ? 'text-accent-amber' :
                        composite.color === 'red'   ? 'text-accent-red'   :
                        'text-text-secondary'}
                    `}>
                      {composite.label}
                    </span>
                    {lastPreflightAt && (
                      <span className="ml-auto text-[11px] text-text-muted tabular-nums shrink-0">
                        {formatPreflightTime(lastPreflightAt)}
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-text-muted mt-0.5 ml-5">{compositeDetail}</p>
                </div>
              )}

              {/* Subtle link to full diagnostics in Tools */}
              {showComposite && !preflightRunning && onGoToTools && (
                <button
                  onClick={onGoToTools}
                  className="mt-1 w-full text-center text-[12px] text-text-muted active:opacity-60"
                >
                  View details in Tools →
                </button>
              )}
            </div>
          )}
        </Card>

        {/* ── Progress steps — hidden when job is inactive (not meaningful) ──── */}
        {/* Keep visible when isBooked, even if now inactive, so "Done" state shows. */}
        {(!isInactive || isBooked) && <Card padding="none">
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
        </Card>}

        {/* ── Readiness ──────────────────────────────────────────── */}
        {(bundle || sessionStatus) && (
          <>
            <SectionHeader title="Readiness" />
            <Card padding="none">
              {/* Account & Session block — Session + Schedule access rows + timestamp */}
              <AccountSessionBlock
                sessionStatus={sessionStatus}
                bundleSession={bundle?.session ?? 'SESSION_UNKNOWN'}
                verifying={sessionChecking}
                authDetail={authDetail}
              />
              {/* Discovery + Modal + Action rows — only shown when sniper has data */}
              {hasReadinessData ? (
                <>
                  <ReadinessRow
                    label="Discovery"
                    value={DISCOVERY_LABEL[bundle!.discovery] ?? bundle!.discovery}
                    dotColor={readinessDotColor(bundle!.discovery)}
                    detail={(() => {
                      if (!discoveryDetail) return undefined
                      if (discoveryDetail.found) {
                        // "7:45 a – 8:45 a Core Pilates · title, time, instr (13)"
                        const parts: string[] = []
                        if (discoveryDetail.matched) parts.push(discoveryDetail.matched)
                        const meta: string[] = []
                        if (discoveryDetail.signals) meta.push(discoveryDetail.signals)
                        if (discoveryDetail.score)   meta.push(`score ${discoveryDetail.score}`)
                        if (meta.length) parts.push(`(${meta.join(', ')})`)
                        return parts.join(' · ')
                      } else {
                        // Not found — show near misses if any
                        if (discoveryDetail.nearMisses) return `Near: ${discoveryDetail.nearMisses}`
                        return 'Class not visible on this day\'s schedule'
                      }
                    })()}
                  />
                  {bundle!.modal !== undefined && bundle!.modal !== 'MODAL_NOT_TESTED' && (
                    <ReadinessRow
                      label="Modal"
                      value={MODAL_LABEL[bundle!.modal] ?? bundle!.modal}
                      dotColor={readinessDotColor(bundle!.modal)}
                      detail={(() => {
                        if (!modalDetail) return undefined
                        if (modalDetail.verdict === 'reachable') {
                          // Show what buttons were visible in the open modal
                          const btns = Array.isArray(modalDetail.buttonsVisible)
                            ? modalDetail.buttonsVisible.join(', ')
                            : null
                          return btns ? `Buttons: ${btns}` : 'Modal opened and verified'
                        }
                        if (modalDetail.verdict === 'login_required') {
                          return 'Login to Register shown — schedule access required'
                        }
                        // blocked
                        return modalDetail.detail
                          ? `Could not open: ${modalDetail.detail}`
                          : 'Modal did not open after card click'
                      })()}
                    />
                  )}
                  <ReadinessRow
                    label="Action"
                    value={ACTION_LABEL[bundle!.action] ?? bundle!.action}
                    dotColor={readinessDotColor(bundle!.action)}
                    last
                    detail={(() => {
                      if (!actionDetail) return undefined
                      switch (actionDetail.verdict) {
                        case 'ready': {
                          // Show which specific button was detected (Register vs Reserve)
                          const btnName = Array.isArray(actionDetail.buttonsVisible)
                            ? actionDetail.buttonsVisible.find(b =>
                                /register|reserve/i.test(b)) ?? 'Register'
                            : 'Register'
                          return `"${btnName}" button visible — ready to book`
                        }
                        case 'waitlist_only':
                          return 'Waitlist available — class is full'
                        case 'login_required':
                          return 'Login to Register shown — use Settings → Log in now'
                        case 'full':
                          return actionDetail.actionState === 'CANCEL_ONLY'
                            ? 'Only Cancel visible — you may already be registered'
                            : 'No booking button found — class may be full'
                        default:
                          return 'Unable to determine available action'
                      }
                    })()}
                  />
                </>
              ) : (
                <div className="px-4 py-3 pb-3">
                  <p className="text-[12px] text-text-muted">Use Check Now above to test discovery &amp; action</p>
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

        {/* ── Test mode notice ───────────────────────────────────── */}
        {appState.dryRun && (
          <Card padding="sm" className="border border-accent-amber/30 bg-accent-amber/5">
            <p className="text-[13px] text-accent-amber font-medium">
              Test mode — the scheduler won't actually register. Switch to Live when ready.
            </p>
          </Card>
        )}
      </ScreenContainer>
    </>
  )
}
