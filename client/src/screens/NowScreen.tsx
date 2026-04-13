import { useEffect, useRef, useState } from 'react'
import { haptic } from '../lib/haptics'
import { playTone } from '../lib/sounds'
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
import type { SniperEvent } from '../lib/failureTypes'
import { api } from '../lib/api'
import {
  SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL, MODAL_LABEL,
  DEFAULT_READINESS, computeCompositeReadiness,
} from '../lib/readinessResolver'
import type { CompositeReadiness, CompositeStatus } from '../lib/readinessResolver'
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
  tab?: import('../components/nav/TabBar').Tab
  onTabChange?: (tab: import('../components/nav/TabBar').Tab) => void
  scrolled?: boolean
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
  bgAction?:        string | null
}): PrimaryResult {
  const {
    isBooked, isInactive, job,
    phase,
    sessionStatus,
    composite, compositeDetail, showComposite,
    bookingActive, lastPreflightAt, bgArmedState, blocked,
    bgSession, bgDiscovery, bgModal, bgAction,
  } = opts

  // ── STATE: booking ─────────────────────────────────────────────────────────
  // Active booking attempt is in progress right now.
  // Stage 1: only trigger on real booking runs (jobState.active via armed.state),
  //          never on preflight, verify, or background checks.
  // Stage 2: window must be open (phase === 'sniper') — no booking before open time.
  if (bookingActive && phase === 'sniper') {
    return {
      state:    'booking',
      label:    'Registering…',
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
      label:    isDryRun ? 'Test run' : 'Registered',
      detail:   isDryRun
        ? 'Test mode — class found and action verified. Switch to Live to actually register.'
        : 'Registration confirmed.',
      severity: 'success',
    }
  }

  // ── STATE: issue ───────────────────────────────────────────────────────────
  // Real failures that require user attention before the system can proceed.

  // Auth / session failure — explicit blocker.
  // Suppressed when the live HTTP ping (bgSession='ready') confirms the session is
  // actually active — prevents a stale 90 s poll result from showing "Login required"
  // while the account icon simultaneously shows a green dot.
  if (
    (sessionStatus?.overall === 'AUTH_NEEDS_LOGIN' ||
     sessionStatus?.overall === 'FAMILYWORKS_SESSION_MISSING') &&
    bgSession !== 'ready'
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
    // Before the registration window opens, the modal and action being
    // inaccessible is expected — not a user-actionable issue. Suppress the
    // card and let the state fall through to 'scheduled' so the user sees
    // normal pre-window status rather than a false alarm.
    const preWindowExpected =
      bgAction === 'not_open' &&
      bgDiscovery !== 'missing' &&
      bgSession   !== 'error'
    if (!preWindowExpected) {
      let detail: string
      let label = 'Issue'
      if (bgDiscovery === 'missing') {
        detail = 'Class not found on the schedule — will check again before the window opens.'
      } else if (bgModal === 'blocked') {
        detail = 'Registration link not accessible — retrying automatically.'
      } else if (bgSession === 'error') {
        detail = 'Sign-in check timed out — the bot is retrying. Tap the account icon if this persists.'
      } else {
        label  = 'Checking'
        detail = 'A recent check timed out — retrying automatically. No action needed.'
      }
      return {
        state:    'issue',
        label,
        detail,
        severity: 'warning',
      }
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
      label:    'Auto-registration ready',
      detail:   'Everything is ready for the registration window.',
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
    detail:   'Registration will start automatically when the window opens.',
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
  sniper:    { label: 'Registering…'  }, // matches canonical vocabulary (ellipsis = in-progress)
  late:      { label: 'Window Closed' },
  unknown:   { label: 'Scheduled'     }, // matches Plan's PHASE_LABEL unknown
}

// ── Stage 2: NowCardState — drives action buttons + inline status ───────────────
// Maps every combination of signals → one definitive card state so the action
// buttons never contradict the displayed registration status.
//
// Intentionally separate from the existing TopLevelState / derivePrimaryResult
// machinery, which continues to drive the "Layer A" result card unchanged.
//
// State priority (highest → lowest):
//   waitlisted / registered  — outcome already known this cycle
//   registration_in_progress — background booking run is active
//   registration_open_full   — preflight confirmed class full (waitlist or no-waitlist)
//   registration_open_with_spots — window open, spots available
//   registration_not_open    — window hasn't opened yet (default / fallback)

export type NowCardState =
  | 'registered'                 // booked this cycle (non-waitlist)
  | 'waitlisted'                 // waitlisted this cycle
  | 'registration_in_progress'   // booking attempt actively running
  | 'auto_registration_armed'    // user armed; scheduler fires at window open
  | 'registration_failed'        // last manual registration attempt failed
  | 'preflight_failed'           // last preflight check failed
  | 'registration_open_with_spots' // window open — Register Now
  | 'registration_open_full'     // window open — class full (isClassFull=no waitlist, else waitlist visible)
  | 'registration_not_open'      // window not open yet

// State priority (highest → lowest):
//   waitlisted / registered         — outcome for this cycle
//   registration_in_progress        — scheduler/manual run active now
//   auto_registration_armed         — armed before window; scheduler fires automatically
//   registration_failed             — most recent manual registration failed
//   preflight_failed                — most recent preflight check failed
//   registration_open_full          — window open but class full
//   registration_open_with_spots    — window open, spots available
//   registration_not_open           — window not open yet (default)
export function deriveNowCardState(opts: {
  isBooked:                 boolean
  lastResult:               string | null
  bookingActive:            boolean
  phase:                    Phase
  effectivePreflightStatus: string | null
  localArmed:               boolean
  lastFailedAction:         'registration' | 'preflight' | null
  domActionState:           string | null   // bgReadiness.action normalized: 'ready'|'not_open'|'waitlist'|'unknown'
  actionDetailVerdict:      string | null   // lastPreflightSnapshot.actionDetail.verdict: 'ready'|'waitlist_only'|'cancel_only'|'not_available'|…
}): NowCardState {
  const { isBooked, lastResult, bookingActive, phase, effectivePreflightStatus, localArmed, lastFailedAction, domActionState, actionDetailVerdict } = opts

  // 1. Cycle outcome already determined (DB source of truth)
  if (isBooked && lastResult === 'waitlist') return 'waitlisted'
  if (isBooked)                              return 'registered'

  // 2. Scheduler-driven or manual registration attempt actively in progress
  if (bookingActive) return 'registration_in_progress'

  // 3. User explicitly armed auto-registration — takes priority over window-open states.
  //    When armed the scheduler fires automatically; the window-open states below would
  //    be misleading (they imply manual action is required).
  if (localArmed) return 'auto_registration_armed'

  // 4. Last manual action failed — show retry before falling to generic pre-open states
  if (lastFailedAction === 'registration') return 'registration_failed'
  if (lastFailedAction === 'preflight')    return 'preflight_failed'

  // 5. DOM action state (most recent modal observation) — used as availability truth.
  //
  //    actionDetailVerdict (from lastPreflightSnapshot.actionDetail.verdict):
  //      'cancel_only'   = Cancel button was the only action visible → user is likely already
  //                        registered. Do NOT map this to any "open" state — let DB (step 1)
  //                        serve as the definitive registered signal once it propagates.
  //                        Safe fallback: registration_not_open (no actionable path shown).
  //      'waitlist_only' = Waitlist button visible via preflight → class full, waitlist open.
  //      'not_available' = No actionable button found (not_available/ACTION_NOT_FOUND) →
  //                        unknown state; cannot confirm class is full. Fall through.
  //
  //    domActionState (from bgReadiness.action, normalised readiness signal):
  //      'ready'    = Register button visible in live DOM → spots available
  //      'waitlist' = Waitlist button visible in live DOM → class full, waitlist open
  //      Others ('not_open', 'unknown') fall through to planning signals below.
  if (actionDetailVerdict === 'cancel_only') return 'registration_not_open'
  if (actionDetailVerdict === 'waitlist_only') return 'registration_open_full'
  if (domActionState === 'waitlist') return 'registration_open_full'
  if (domActionState === 'ready' && phase === 'sniper') return 'registration_open_with_spots'

  // 6. Planning signals — class confirmed full/unavailable via preflight overall status
  if (effectivePreflightStatus === 'waitlist_only') return 'registration_open_full'
  // Stage 2/6: 'full' = class is full with NO waitlist button ("Closed - Full" only).
  // Uses registration_open_full so the armed state shows class-full banners/confidence.
  // isClassFull flag (NowScreen) differentiates button/banner/confidence from waitlist_only.
  if (effectivePreflightStatus === 'full')          return 'registration_open_full'
  // 'closed' = registration explicitly closed (not just window timing)
  if (effectivePreflightStatus === 'closed')        return 'registration_not_open'

  // 7. Registration window is open — assume spots available unless DOM/preflight says otherwise
  if (phase === 'sniper') return 'registration_open_with_spots'

  // 8. Default — window not yet open (too_early, warmup, late, unknown)
  return 'registration_not_open'
}

// ── Unified NowState — four-value availability model ─────────────────────────
// Collapses the multi-state NowCardState down to a single availability answer
// for planning and action routing. Used by resolveNowState and as documentation
// for the decision logic below.
//
//   before_open       — registration window has not opened yet; arm auto-registration
//   register_now      — spots available; attempt immediate registration
//   join_waitlist     — class is full; waitlist is open
//   already_registered — cancel button visible in DOM; user appears already registered
//   unavailable       — window closed or no actionable path

export type NowState = 'before_open' | 'register_now' | 'join_waitlist' | 'already_registered' | 'unavailable'

// Resolver: derives NowState from time, availability signals, and DOM observation.
//
// Decision order:
//   1. DOM action state (most recent modal observation) = final execution truth
//      when it provides a definitive answer
//   2. Phase-based planning: sniper = window open, too_early/warmup = before open
//   3. Preflight signals for waitlist detection
//
// Note: the bot's handleNowBook always re-reads the live DOM when actually
// executing — DOM state here is for display intent, not click routing.
export function resolveNowState(opts: {
  phase:                    Phase
  domActionState:           string | null   // bgReadiness.action normalized: 'ready'|'not_open'|'waitlist'|'unknown'
  actionDetailVerdict:      string | null   // actionDetail.verdict: 'ready'|'waitlist_only'|'cancel_only'|'not_available'|…
  effectivePreflightStatus: string | null
}): NowState {
  const { phase, domActionState, actionDetailVerdict, effectivePreflightStatus } = opts

  // Cancel button visible in DOM → user is already registered (most likely).
  // This is higher-confidence than phase-based guessing; check before open/closed logic.
  if (actionDetailVerdict === 'cancel_only') return 'already_registered'

  // DOM normalized readiness as availability truth (bgReadiness.action)
  //   'ready'    = Register button visible → spots available
  //   'waitlist' = Waitlist button visible → class full, waitlist open
  //   Others fall through to planning signals
  if (domActionState === 'ready')    return 'register_now'
  if (domActionState === 'waitlist') return 'join_waitlist'

  // actionDetail verdict provides richer signal when bgReadiness is stale
  if (actionDetailVerdict === 'ready')        return 'register_now'
  if (actionDetailVerdict === 'waitlist_only') return 'join_waitlist'
  if (actionDetailVerdict === 'not_available' || actionDetailVerdict === 'login_required') return 'unavailable'

  // Fall back to planning signals
  if (phase === 'late') return 'unavailable'
  if (phase === 'sniper') {
    if (effectivePreflightStatus === 'waitlist_only') return 'join_waitlist'
    return 'register_now'
  }

  // Window has not opened yet (too_early, warmup, unknown)
  return 'before_open'
}

// ── Stage 3: SmartButtonConfig — single primary action resolver ─────────────
// Collapses all card-state branches into one config object so the render
// section stays thin.  No side-effects; pure function of card state.
//
// emphasis values:
//   'primary-blue'  — filled blue pill (default CTA)
//   'primary-amber' — filled amber pill (waitlist CTA)
//   'muted'         — surface/border pill, non-interactive appearance

export interface SmartButtonConfig {
  label:      string
  actionType: 'register' | 'waitlist' | 'arm' | 'disarm' | 'none'
  helperText: string | null
  disabled:   boolean
  emphasis:   'primary-blue' | 'primary-amber' | 'muted' | 'outline-red'
}

export function resolveSmartButton(opts: {
  cardState:         NowCardState
  countdown:         string | null
  bookingOpenMs:     number | null
  nextWindow:        string | null
  isWaitlistScenario?: boolean
  isClassFull?:        boolean   // Stage 6: full = no waitlist button visible
}): SmartButtonConfig {
  const { cardState, countdown, bookingOpenMs, nextWindow, isWaitlistScenario = false, isClassFull = false } = opts

  switch (cardState) {
    case 'registered':
      return { label: 'Registered ✓',  actionType: 'none',    helperText: null,                                 disabled: true,  emphasis: 'muted'         }
    case 'waitlisted':
      return { label: 'On waitlist',   actionType: 'none',    helperText: null,                                 disabled: true,  emphasis: 'muted'         }
    case 'registration_in_progress':
      return { label: 'Registering…',  actionType: 'none',    helperText: null,                                 disabled: true,  emphasis: 'primary-blue'  }
    case 'registration_open_with_spots':
      return { label: 'Get Spot',      actionType: 'register', helperText: 'Spots available',                   disabled: false, emphasis: 'primary-blue'  }
    case 'registration_open_full':
      // Stage 6: distinguish "full, no waitlist" from "full, waitlist visible"
      if (isClassFull) {
        return { label: 'Class Full',    actionType: 'none',    helperText: 'No spots or waitlist available',    disabled: true,  emphasis: 'muted'         }
      }
      return { label: 'Join Waitlist', actionType: 'waitlist', helperText: 'Class is full · Waitlist available', disabled: false, emphasis: 'primary-amber' }
    case 'auto_registration_armed': {
      const windowTime = nextWindow ? fmtWindowTime(nextWindow) : null
      const helperText = isWaitlistScenario
        ? (windowTime ? `Will join waitlist at ${windowTime}` : 'Will join waitlist when the window opens')
        : (windowTime ? `Will register at ${windowTime}`      : 'Will register when the window opens')
      return { label: 'Cancel Auto-registration', actionType: 'disarm', helperText, disabled: false, emphasis: 'outline-red' }
    }
    case 'registration_failed':
      return { label: 'Retry Registration', actionType: 'register', helperText: 'Last registration attempt failed', disabled: false, emphasis: 'primary-blue' }
    case 'preflight_failed':
      return { label: 'Run Check Again',   actionType: 'arm',      helperText: "Last check didn't pass",           disabled: false, emphasis: 'primary-blue' }
    case 'registration_not_open': {
      // Prefer absolute time ("opens at 10:35 AM") — more useful on mobile than
      // a raw countdown that requires mental math.  Fall back to countdown when
      // we have it but can't compute the absolute time, and to null when neither
      // is available (e.g. job has no class_time configured).
      const openAt = bookingOpenMs != null ? new Date(Date.now() + bookingOpenMs) : null
      const timeStr = openAt
        ? openAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null
      const helperText = timeStr
        ? `Registration opens at ${timeStr}`
        : (countdown ? `Registration opens in ${countdown}` : null)
      return { label: 'Get Spot', actionType: 'arm', helperText, disabled: false, emphasis: 'primary-blue' }
    }
  }
}

// ── Secondary action state resolver ──────────────────────────────────────────
// Drives the dynamic label on the Options / secondary button.
// Priority (highest → lowest):
//   status  — registration actively in progress (button is hidden anyway)
//   fix     — last action failed; guide user to retry
//   ready   — armed and system looks healthy; reassure, no urgency
//   check   — low confidence or a readiness issue detected; nudge user
//   options — default; no strong signal

export type SecondaryActionState = 'options' | 'check' | 'ready' | 'fix' | 'status'

export function resolveSecondaryAction(opts: {
  nowCardState:    NowCardState
  confidenceLabel: ConfidenceLabel | null
  compositeColor:  'green' | 'amber' | 'red'
  localArmed:      boolean
  bgSession:       string | null
  bgDiscovery:     string | null
}): SecondaryActionState {
  const { nowCardState, confidenceLabel, compositeColor, localArmed, bgSession, bgDiscovery } = opts

  // 1. Registration actively in progress (Options button is hidden when disabled,
  //    but guard here for completeness / future use)
  if (nowCardState === 'registration_in_progress') return 'status'

  // 2. Last action failed — guide user to fix it
  if (nowCardState === 'registration_failed' || nowCardState === 'preflight_failed') return 'fix'

  // 3. Armed and healthy — pure reassurance
  if (localArmed && (confidenceLabel === 'High confidence' || compositeColor === 'green')) return 'ready'

  // 4. Something looks off — nudge user to check
  if (
    confidenceLabel === 'Low confidence' ||
    compositeColor  === 'red'            ||
    bgSession       === 'error'          ||
    bgDiscovery     === 'missing'
  ) return 'check'

  // 5. Default
  return 'options'
}

// ── Confidence summary resolver ───────────────────────────────────────────────
// Maps the current readiness signals to a human-friendly confidence assessment
// shown below the persistent preflight checklist when armed.
// Four levels — priority highest → lowest:
//   check_recommended — an issue was found (error/failure/red/missing)
//   needs_attention   — amber signals or medium confidence (partial pass)
//   very_likely       — composite green + high confidence (everything confirmed)
//   likely            — default armed state (no bad signal; green or unknown)

export type ConfidenceLevel = 'very_likely' | 'likely' | 'needs_attention' | 'check_recommended'

export interface ConfidenceSummary {
  level:  ConfidenceLevel
  label:  string
  reason: string
}

export function resolveConfidenceSummary(opts: {
  nowCardState:        NowCardState
  compositeColor:      'green' | 'amber' | 'red'
  compositeStatus:     CompositeStatus
  confidenceLabel:     ConfidenceLabel | null
  bgSession:           string | null
  bgDiscovery:         string | null
  sessionFailureType?: string | null
  isClassFull?:        boolean   // Stage 6: full = no waitlist button (vs waitlist_only = waitlist visible)
}): ConfidenceSummary {
  const { nowCardState, compositeColor, compositeStatus, confidenceLabel, bgSession, bgDiscovery, sessionFailureType, isClassFull = false } = opts

  // check_recommended: any error/failure signal present
  const hasIssue =
    nowCardState === 'registration_failed' ||
    nowCardState === 'preflight_failed'    ||
    compositeColor === 'red'               ||
    bgSession      === 'error'             ||
    bgDiscovery    === 'missing'           ||
    confidenceLabel === 'Low confidence'

  if (hasIssue) {
    // Surface a specific reason when we know what went wrong
    const reason =
      bgSession === 'error' && sessionFailureType === 'timeout'
        ? 'The YMCA site timed out — this is usually temporary. Checks will resume automatically in a few minutes.'
        : bgSession === 'error'
        ? 'Session issue detected — tap the account icon to re-authenticate.'
        : bgDiscovery === 'missing'
          ? 'Class could not be found on the schedule. Run a fresh check before the window opens.'
          : compositeStatus === 'COMPOSITE_CLASS_CLOSED'
            ? 'Registration is closed for this class — the YMCA has ended sign-ups.'
            : nowCardState === 'registration_failed'
              ? 'Last registration attempt failed. Run a fresh check to diagnose.'
              : nowCardState === 'preflight_failed'
                ? 'Last readiness check found a problem. Review and re-run when ready.'
                : 'A potential issue was detected. Run a check to confirm status before the window opens.'
    return {
      level:  'check_recommended',
      label:  compositeStatus === 'COMPOSITE_CLASS_CLOSED' ? 'Registration closed' : 'Check recommended',
      reason,
    }
  }

  // Stage 2/6: Full class guard — registration_open_full means the class is known
  // to be full regardless of what the composite badge says.
  // Stage 6 distinction: full (no waitlist button) vs waitlist_only (waitlist visible).
  if (nowCardState === 'registration_open_full') {
    if (isClassFull) {
      // No waitlist button visible — class is full with nowhere to join.
      return {
        level:  'check_recommended',
        label:  'Class full',
        reason: 'Class is full with no waitlist available. Auto-registration will attempt when the window opens in case a spot is released.',
      }
    }
    // Waitlist button visible — bot will join the waitlist.
    return {
      level:  'needs_attention',
      label:  'Waitlist only',
      reason: 'Class is currently full. Auto-registration will join the waitlist when the window opens.',
    }
  }

  // Stage 5: Safety net — COMPOSITE_CLASS_FULL shouldn't reach here (the
  // registration_open_full guard above catches it), but if the composite status
  // and card state diverge, return the truthful label rather than "Likely to succeed".
  if (compositeStatus === 'COMPOSITE_CLASS_FULL') {
    return {
      level:  'needs_attention',
      label:  'Class full',
      reason: 'Class is full — no spots available.',
    }
  }

  // COMPOSITE_ACTION_BLOCKED = "not open yet" — the window simply hasn't opened.
  // All checks that can run pre-window have passed; treat as likely/very_likely,
  // not needs_attention (which would be alarming and incorrect).
  if (compositeStatus === 'COMPOSITE_ACTION_BLOCKED') {
    if (confidenceLabel === 'High confidence') {
      return {
        level:  'very_likely',
        label:  'Very likely to succeed',
        reason: 'Session, class, and registration button all confirmed.',
      }
    }
    return {
      level:  'likely',
      label:  'Likely to succeed',
      reason: 'Core checks passed.',
    }
  }

  // COMPOSITE_WAITLIST = class is full, waitlist available — worth noting specifically
  if (compositeStatus === 'COMPOSITE_WAITLIST') {
    return {
      level:  'needs_attention',
      label:  'Waitlist only',
      reason: 'Class is currently full. Auto-registration will join the waitlist when the window opens.',
    }
  }

  // Other amber signals or medium confidence
  if (compositeColor === 'amber' || confidenceLabel === 'Medium confidence') {
    return {
      level:  'needs_attention',
      label:  'Needs attention',
      reason: 'Moderate confidence — some signals were inconclusive. Consider running a fresh check.',
    }
  }

  // very_likely: composite green + high confidence = everything confirmed
  if (compositeColor === 'green' && confidenceLabel === 'High confidence') {
    return {
      level:  'very_likely',
      label:  'Very likely to succeed',
      reason: 'Session, class, and registration button all confirmed.',
    }
  }

  // likely: default armed state — green composite but confidence not yet measured
  return {
    level:  'likely',
    label:  'Likely to succeed',
    reason: 'Core checks passed.',
  }
}

// ── Stage 5: Live status derivation ──────────────────────────────────────────
// Maps the current sniper phase to a concise, human-readable status text +
// an optional subtext (e.g. "Will register at 10:20 PM").
// Shown directly below the 5-segment sniper strip dots.

interface LiveStatusLine {
  text:    string
  subtext: string | null
}

function fmtWindowTime(iso: string | null): string | null {
  if (!iso) return null
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
  catch { return null }
}

function deriveLiveStatus(sp: SniperPhase, nextWindow: string | null): LiveStatusLine {
  switch (sp) {
    case 'monitoring':
      return { text: 'Watching for registration',    subtext: null }
    case 'locked':
      return { text: 'Registration opens soon',      subtext: null }
    case 'armed':
      return { text: 'Auto-registration ready',      subtext: nextWindow ? `Will register at ${fmtWindowTime(nextWindow)}` : null }
    case 'countdown':
      return { text: 'Auto-registration ready',      subtext: null }
    case 'firing':
      return { text: 'Registering\u2026',            subtext: null }
    case 'confirming':
      return { text: 'Confirming registration\u2026',subtext: null }
  }
}

// ── Stage 5: Timeline event labelling ────────────────────────────────────────
// Maps a raw SniperEvent to a user-facing one-liner.
// Deep diagnostic detail stays in Tools; Now screen shows the human outcome.

function friendlyEventLabel(ev: SniperEvent): string {
  const msg = (ev.message ?? '').toLowerCase()
  if (ev.failureType) {
    switch (ev.phase) {
      case 'AUTH':         return 'Session check failed'
      case 'NAVIGATION':   return 'Schedule could not load'
      case 'DISCOVERY':    return 'Class not found'
      case 'VERIFY':       return 'Class could not be confirmed'
      case 'MODAL':        return 'Registration page unavailable'
      case 'ACTION':       return 'Registration failed'
      case 'CONFIRMATION': return 'Result unclear — check Tools'
      case 'RECOVERY':     return 'Recovery attempt failed'
      default:             return 'Check failed'
    }
  }
  switch (ev.phase) {
    case 'AUTH':         return 'Session verified'
    case 'NAVIGATION':   return 'Schedule loaded'
    case 'DISCOVERY':    return 'Class detected'
    case 'VERIFY':       return 'Class confirmed'
    case 'MODAL':        return 'Registration page reached'
    case 'ACTION':       return msg.includes('waitlist') ? 'Waitlist action submitted' : 'Registration submitted'
    case 'CONFIRMATION': return msg.includes('waitlist') ? 'Joined waitlist'           : 'Successfully registered'
    case 'RECOVERY':     return 'Retry scheduled'
    case 'SYSTEM':       return 'System monitoring active'
    default:             return ev.message || 'Activity recorded'
  }
}

// Returns true for events that belong in Recent Activity on the Now screen.
// Setup-phase successes (AUTH/NAVIGATION/DISCOVERY/VERIFY/MODAL) are already
// shown in the persistent preflight checklist — repeating them in the timeline
// creates clutter.  Keep failures always, and high-level outcomes only.
function isMilestoneEvent(ev: SniperEvent): boolean {
  if (ev.failureType) return true   // always surface failures
  switch (ev.phase) {
    case 'ACTION':       return true  // registration submitted
    case 'CONFIRMATION': return true  // registered / waitlisted
    case 'RECOVERY':     return true  // retry scheduled
    case 'SYSTEM':       return true  // system-level events
    default:             return false // AUTH/NAVIGATION/DISCOVERY/VERIFY/MODAL successes → checklist
  }
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
  // Accept booked/success/dry_run as confirmed, and waitlist as an active outcome
  // (class full — joined waitlist). All suppress the booking countdown.
  const isConfirmed = job.last_result === 'booked' || job.last_result === 'success' ||
                      job.last_result === 'dry_run' || job.last_result === 'waitlist'
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

export function NowScreen({ appState, selectedJobId, loading, error, refresh, onGoToTools, onAccount, accountAttention, authStatus, polledStatus, onDismissEscalation, bgRefreshSignal, tab = 'now', onTabChange = () => {}, scrolled = false }: NowScreenProps) {
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

  const [resetting,        setResetting]        = useState(false)
  const [showActionSheet,  setShowActionSheet]  = useState(false)
  const [showCancelSheet,  setShowCancelSheet]  = useState(false)
  const [cancelInProgress, setCancelInProgress] = useState(false)
  const [cancelResult,     setCancelResult]     = useState<{ ok: boolean; text: string } | null>(null)

  // ── Sniper readiness state ─────────────────────────────────────────────────
  const [sniperRunState, setSniperRunState] = useState<SniperRunState | null>(null)

  useEffect(() => {
    api.getSniperState().then(setSniperRunState).catch(() => {})
    const id = setInterval(() => {
      api.getSniperState().then(setSniperRunState).catch(() => {})
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  // ── Auto-registration armed state — persisted across reloads ─────────────
  // Set when the user clicks "Get Spot" and preflight confirms session, class,
  // and modal are all reachable. Cleared when the class books, the window
  // passes, or the user explicitly taps "Cancel Auto-registration".
  // Key is per-job so switching classes starts fresh.
  const armedKey = selectedJobId != null ? `ymca_auto_armed_${selectedJobId}` : null
  const [localArmed, setLocalArmedState] = useState<boolean>(false)

  // Re-read from localStorage whenever the selected job changes.
  useEffect(() => {
    if (!armedKey) { setLocalArmedState(false); return }
    try { setLocalArmedState(localStorage.getItem(armedKey) === '1') }
    catch { setLocalArmedState(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedKey])

  // Auto-clear when the class is booked or the registration window has passed.
  // Also removes the localStorage entry so the next cycle starts fresh.
  useEffect(() => {
    if (isBooked || phase === 'late') {
      setLocalArmedState(false)
      if (armedKey) { try { localStorage.removeItem(armedKey) } catch { /* ignored */ } }
    }
  }, [isBooked, phase, armedKey])

  const setArmed = (v: boolean) => {
    setLocalArmedState(v)
    if (!armedKey) return
    try {
      if (v) localStorage.setItem(armedKey, '1')
      else   localStorage.removeItem(armedKey)
    } catch { /* ignored */ }
  }

  // ── Last manual action failure — persists after execMode resets to idle ──────
  // Survives the 20 s step-animation auto-reset so the card keeps showing
  // "Retry Registration" / "Run Check Again" until the user acts or the job changes.
  // Cleared at the start of any new attempt, on success, and on job change.
  const [lastFailedAction, setLastFailedAction] = useState<'registration' | 'preflight' | null>(null)

  useEffect(() => {
    setLastFailedAction(null)
    setExecSteps(BLANK_STEPS)
    setExecDone(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId])

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

  // Adaptive readiness poll: check more frequently as the window approaches.
  // msUntilOpen is server-computed at the last poll time — accurate enough for
  // threshold-based bucketing since thresholds are wide relative to poll lag.
  const msUntilOpen = bgReadiness?.executionTiming?.msUntilOpen ?? null
  const readinessPollMs: number = (() => {
    if (isHotPhase)                             return      1_000  // 1 s   — armed / warmup / sniper
    if (msUntilOpen == null || msUntilOpen <= 0) return     30_000  // 30 s  — window open or timing unknown
    if (msUntilOpen > 4 * 60 * 60_000)          return 15 * 60_000  // 15 min — > 4 h out
    if (msUntilOpen > 60 * 60_000)              return 10 * 60_000  // 10 min — 1–4 h out
    if (msUntilOpen > 30 * 60_000)              return  5 * 60_000  // 5 min  — 30–60 min out
    if (msUntilOpen > 15 * 60_000)              return  2 * 60_000  // 2 min  — 15–30 min out
    if (msUntilOpen > 5 * 60_000)              return     60_000   // 1 min  — 5–15 min out
    return 15_000                                                    // 15 s   — < 5 min out
  })()

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

  // Imperative refresh — parent bumps bgRefreshSignal to force an immediate re-fetch.
  // Used after escalation dismiss and after Account sheet closes (login/re-auth).
  // Re-fetches both readiness and session so the Issue card clears promptly.
  useEffect(() => {
    if (!bgRefreshSignal) return
    api.getReadiness().then(setBgReadiness).catch(() => {})
    api.getSessionStatus().then(setLocalSessionStatus).catch(() => {})
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

  const handleCancelConfirm = async () => {
    if (!job || cancelInProgress) return
    setCancelInProgress(true)
    setShowCancelSheet(false)
    setCancelResult(null)
    try {
      const r = await api.cancelRegistration(job.id)
      setCancelResult({ ok: r.success, text: r.success ? (r.action === 'left_waitlist' ? 'Left waitlist' : 'Registration cancelled') : (r.message || 'Could not cancel') })
      if (r.success) refresh()
    } catch (e) {
      setCancelResult({ ok: false, text: e instanceof Error ? e.message : 'Cancel failed' })
    } finally {
      setCancelInProgress(false)
    }
  }

  // ── Now-tab manual execution state ─────────────────────────────────────────
  type ExecMode = 'idle' | 'running_preflight' | 'running_booking' | 'done'
  type StepKey  = 'session' | 'schedule' | 'class' | 'modal' | 'confirmed' | 'action' | 'result'
  type StepStatus = 'pending' | 'running' | 'success' | 'failed'
  type ExecSteps  = Record<StepKey, StepStatus>

  const PREFLIGHT_STEP_LIST: StepKey[]     = ['session', 'schedule', 'class', 'modal']
  // Visual checklist — includes a virtual 'confirmed' row that represents the
  // final "registration path confirmed" state once armed.
  const PREFLIGHT_CHECKLIST_STEPS: StepKey[] = ['session', 'schedule', 'class', 'modal', 'confirmed']
  const BOOK_STEP_LIST:      StepKey[]     = ['session', 'schedule', 'class', 'modal', 'action', 'result']
  const STEP_LABELS: Record<StepKey, string> = {
    session:   'Session verified',
    schedule:  'Schedule loaded',
    class:     'Class found',
    modal:     'Modal reached',
    confirmed: 'Registration path confirmed',
    action:    'Registration action',
    result:    'Confirmation detected',
  }
  const BLANK_STEPS: ExecSteps = {
    session: 'pending', schedule: 'pending', class: 'pending',
    modal: 'pending', confirmed: 'pending', action: 'pending', result: 'pending',
  }

  const [execMode,   setExecMode]   = useState<ExecMode>('idle')
  const [execSteps,  setExecSteps]  = useState<ExecSteps>(BLANK_STEPS)
  const [execDone,   setExecDone]   = useState<{ ok: boolean; text: string; color: 'green' | 'amber' | 'red' } | null>(null)
  const [execStepList, setExecStepList] = useState<StepKey[]>(PREFLIGHT_STEP_LIST)
  // Guard state — live preflight check before committing to a booking run.
  // Shown only in late phase so we don't add latency to the sniper window.
  const [guardState,   setGuardState]   = useState<'checking' | 'waitlist_only' | 'blocked' | null>(null)
  const [guardMessage, setGuardMessage] = useState<string | null>(null)

  const stepTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneTimerRef     = useRef<ReturnType<typeof setTimeout>  | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stepIdxRef       = useRef(0)

  // Refs used by the visibilitychange handler so it never has stale closures.
  const execModeRef = useRef<ExecMode>('idle')
  execModeRef.current = execMode
  const hiddenAtRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (stepTimerRef.current)      clearInterval(stepTimerRef.current)
    if (doneTimerRef.current)      clearTimeout(doneTimerRef.current)
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
  }, [])

  // Close the action sheet whenever an execution starts (execMode leaves 'idle')
  useEffect(() => {
    if (execMode !== 'idle') setShowActionSheet(false)
  }, [execMode])

  // Re-fetch readiness after any exec finishes so the trust line stays visible.
  useEffect(() => {
    if (execMode === 'done') {
      api.getReadiness().then(setBgReadiness).catch(() => {})
    }
  }, [execMode])

  // Foreground-resume handler: re-fetch stale data and clear ghost exec states.
  // iOS suspends JS timers when the app goes to background, so polling intervals
  // stop and state can be many minutes old when the user returns. This handler
  // fires immediately when the page becomes visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now()
      } else {
        api.getReadiness().then(setBgReadiness).catch(() => {})
        api.getSniperState().then(setSniperRunState).catch(() => {})
        api.getSessionStatus().then(setLocalSessionStatus).catch(() => {})
        const awayMs = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0
        hiddenAtRef.current = null
        // If an exec was "in flight" when backgrounded for > 60 s, the simulation
        // is a ghost — the bot run finished long ago. Clear it so the normal UI
        // (Get Spot button, Scheduled card) is visible immediately on return.
        if (awayMs > 60_000 && execModeRef.current !== 'idle') {
          if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
          if (doneTimerRef.current) { clearTimeout(doneTimerRef.current);  doneTimerRef.current = null }
          setExecMode('idle')
          setExecDone(null)
          setExecSteps({ session: 'pending', schedule: 'pending', class: 'pending', modal: 'pending', action: 'pending', result: 'pending' })
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, []) // empty deps — state access goes through refs or stable React setters

  const startStepSimulation = (steps: StepKey[]) => {
    if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
    stepIdxRef.current = 0
    setExecStepList(steps)
    setExecSteps({ ...BLANK_STEPS, [steps[0]]: 'running' })
    stepTimerRef.current = setInterval(() => {
      const idx = stepIdxRef.current
      setExecSteps(prev => {
        const next = { ...prev }
        if (steps[idx]) next[steps[idx]] = 'success'
        stepIdxRef.current++
        const ni = stepIdxRef.current
        if (ni < steps.length - 1) next[steps[ni]] = 'running'
        else if (ni === steps.length - 1) next[steps[ni]] = 'running'
        return next
      })
      if (stepIdxRef.current >= steps.length - 1) {
        clearInterval(stepTimerRef.current!); stepTimerRef.current = null
      }
    }, 7_000)
  }

  const finalizeSteps = (steps: StepKey[], failIdx: number | null) => {
    if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
    setExecSteps(prev => {
      const next = { ...prev }
      steps.forEach((step, i) => {
        if (failIdx !== null) {
          if (i < failIdx)       next[step] = 'success'
          else if (i === failIdx) next[step] = 'failed'
          else                    next[step] = 'pending'
        } else {
          next[step] = 'success'
        }
      })
      return next
    })
  }

  const scheduleDoneReset = (delayMs = 20000) => {
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    doneTimerRef.current = setTimeout(() => {
      // Only clear execMode — leave execSteps and execDone in place so the
      // unified checklist continues to show the last result in idle state
      // (e.g. the red failed row stays visible until the next run starts).
      setExecMode('idle')
      doneTimerRef.current = null
    }, delayMs)
  }

  const handleNowPreflight = async () => {
    if (!job || (execMode !== 'idle' && execMode !== 'done')) return
    haptic('medium')            // "Get Spot" tap — medium impact
    // Cancel any pending auto-reset timer so it doesn't interrupt the retry run
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null }
    setLastFailedAction(null)   // clear stale failure before starting
    setExecSteps(BLANK_STEPS)   // reset checklist rows for a fresh run
    setExecDone(null)
    setExecMode('running_preflight')
    startStepSimulation(PREFLIGHT_STEP_LIST)
    // Track whether the check resulted in an armed state so the finally block
    // can use a short done-reset delay (2 s) instead of the normal 20 s.
    // Short delay = the amber confirmation flashes briefly, then the armed
    // checklist + "Very likely to succeed" appears without a jarring 20 s wait.
    let armedThisRun = false
    try {
      const r = await api.runPreflight(job.id)
      // "found_not_open_yet" = session ok, class found, modal reachable —
      // registration window just isn't open yet. All steps pass; show amber.
      if (r.status === 'found_not_open_yet') {
        finalizeSteps(PREFLIGHT_STEP_LIST, null)
        haptic('selection')  // checklist fully ready — subtle confirmation
        setArmed(true)
        armedThisRun = true
        setExecDone({ ok: true, text: 'Auto-registration ready — registers when the window opens', color: 'amber' })
      } else {
        const failIdx: number | null = (() => {
          if (r.authDetail?.verdict === 'FAILED')                                          return 0
          if (r.discoveryDetail && !r.discoveryDetail.found)                               return 2
          if (r.modalDetail && !r.modalDetail.verdict?.toLowerCase().includes('reachable')) return 3
          return r.success ? null : 3
        })()
        finalizeSteps(PREFLIGHT_STEP_LIST, failIdx)
        // Derive text from failIdx (structured) not msg (string-match) to avoid
        // "Class not found" appearing when failure was actually at the modal step.
        const text = r.success
          ? 'Ready to register'
          : failIdx === 0 ? 'Session expired — sign in again'
          : failIdx === 2 ? 'Class not found on schedule'
          : failIdx === 3 ? 'Could not access registration link'
          : (r.message ?? 'Registration check blocked')
        setExecDone({ ok: r.success, text, color: r.success ? 'green' : 'red' })
        if (r.success) { haptic('selection'); setArmed(true); armedThisRun = true }
        else { haptic('error'); setLastFailedAction('preflight') }
      }
    } catch (e) {
      haptic('error')
      finalizeSteps(PREFLIGHT_STEP_LIST, 0)
      setExecDone({ ok: false, text: e instanceof Error ? e.message : 'Registration check failed', color: 'red' })
      setLastFailedAction('preflight')
    } finally {
      setExecMode('done')
      // Armed success: transition to the idle armed state (green checklist +
      // confidence summary) after just 2 s — long enough to read the confirmation,
      // short enough that it doesn't feel stuck on the amber banner.
      // Failure / non-armed success: keep the standard 20 s so the user has time
      // to read the result message before it clears.
      scheduleDoneReset(armedThisRun ? 2000 : 20000)
    }
  }

  const handleDisarm = () => { haptic('light'); setArmed(false) }

  // Core booking flow — runs directly without any guard check.
  // Call this only after the guard has passed (or when guard is not needed).
  const performBooking = async () => {
    if (!job) return
    if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null }
    setGuardState(null)
    setGuardMessage(null)
    setLastFailedAction(null)
    setExecSteps(BLANK_STEPS)
    setExecMode('running_booking')
    setExecDone(null)
    startStepSimulation(BOOK_STEP_LIST)
    try {
      const r = await api.forceRunJob(job.id)
      const msg = (r.message ?? '').toLowerCase()
      const isWaitlist = msg.includes('waitlist')
      const failIdx: number | null = r.success !== false ? null : (() => {
        if (msg.includes('session') || msg.includes('auth') || msg.includes('login')) return 0
        if (msg.includes('class') || msg.includes('not found'))                        return 2
        if (msg.includes('modal'))                                                     return 3
        return 4
      })()
      finalizeSteps(BOOK_STEP_LIST, failIdx)
      const color: 'green' | 'amber' | 'red' = r.success !== false
        ? (isWaitlist ? 'amber' : 'green')
        : 'red'
      const text = r.success !== false
        ? (isWaitlist ? 'On waitlist' : 'Registered')
        : msg.includes('session') || msg.includes('auth') || msg.includes('login')
          ? 'Session expired — sign in again'
          : msg.includes('class') || msg.includes('not found')
            ? 'Class not found on schedule'
            : msg.includes('modal')
              ? 'Could not access registration modal'
              : (r.message ?? 'Registration failed')
      setExecDone({ ok: r.success !== false, text, color })
      if (r.success !== false) { haptic('success'); playTone('success') }
      else                     { haptic('error');   playTone('error');   setLastFailedAction('registration') }
      refresh()
    } catch (e) {
      haptic('error'); playTone('error')
      finalizeSteps(BOOK_STEP_LIST, 0)
      setExecDone({ ok: false, text: e instanceof Error ? e.message : 'Registration failed', color: 'red' })
      setLastFailedAction('registration')
    } finally {
      setExecMode('done')
      scheduleDoneReset()
    }
  }

  // Entry point for booking — runs a live preflight guard when the registration
  // window is past (phase === 'late') so the user gets informed BEFORE attempting
  // a booking that might fail because the class is full or session has expired.
  // In sniper/warmup phase the guard is skipped to avoid adding latency.
  const handleNowBook = async () => {
    if (!job || (execMode !== 'idle' && execMode !== 'done')) return
    if (bgReadiness?.armed?.state === 'booking') return

    if (phase === 'late') {
      setGuardState('checking')
      setGuardMessage(null)
      try {
        const r = await api.runPreflight(job.id)
        if (r.status === 'success') {
          // All clear — proceed straight to booking with no extra prompt.
          await performBooking()
          return
        }
        if (r.status === 'waitlist_only') {
          haptic('medium')
          setGuardState('waitlist_only')
          setGuardMessage('Class is full — only Waitlist is available')
          return
        }
        // Any other non-success: surface the reason and stop.
        haptic('error')
        const errText =
          r.status === 'full'                                ? 'Class is full — no spots available'   :
          r.status === 'closed'                              ? 'Registration is closed'               :
          r.status === 'not_found'                           ? 'Class not found on schedule'          :
          r.authDetail?.verdict === 'session_expired'        ? 'Session expired — sign in in Settings' :
          r.authDetail?.verdict === 'login_required'         ? 'Not logged in — sign in in Settings'  :
          r.status === 'found_not_open_yet'                  ? 'Registration window not open yet'     :
          (r.message ?? 'Registration check failed')
        setGuardState('blocked')
        setGuardMessage(errText)
      } catch (e) {
        haptic('error')
        setGuardState('blocked')
        setGuardMessage(e instanceof Error ? e.message : 'Could not check registration status')
      }
      return
    }

    // Not in late phase — proceed directly (no guard latency in sniper window).
    await performBooking()
  }

  // Confirm: user chose to join waitlist after the guard detected class is full.
  const handleGuardJoinWaitlist = () => performBooking()
  // Dismiss the guard overlay and return to idle.
  const handleGuardCancel = () => { setGuardState(null); setGuardMessage(null) }

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

  // True when the active (or just-completed) exec run was a booking, not a preflight.
  // Used to show the booking-specific 6-step list instead of the unified
  // preflight checklist (which is always visible for preflight states).
  const isBookingFlow =
    execMode === 'running_booking' ||
    (execMode === 'done' && execStepList.length === BOOK_STEP_LIST.length)

  // Standby heartbeat row — "Waiting for registration window".
  // Conditions (all must be true):
  //   • user has armed auto-registration (localArmed)
  //   • exec is idle (no check or booking in flight)
  //   • no failure is active (lastFailedAction null)
  //   • class not yet registered (isBooked false)
  //   • window has not opened (phase too_early or warmup)
  // Removed automatically when window opens (phase→sniper/late), registration
  // starts, fails, is cancelled, or the class becomes registered.
  const showStandbyRow =
    localArmed        &&
    execMode === 'idle' &&
    !lastFailedAction &&
    !isBooked         &&
    (phase === 'too_early' || phase === 'warmup')

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
    bgAction:     bgReadiness?.action    ?? null,
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

  // ── Stage 2: NowCardState — drives action buttons ──────────────────────────
  // Computed from existing signals; no new API calls required.
  // Only used when execMode === 'idle' (running/done states have their own UI).
  // Richer per-preflight action verdict (from lastPreflightSnapshot.actionDetail.verdict).
  // Unlike the normalized bgReadiness.action, this preserves 'cancel_only', 'waitlist_only',
  // 'not_available', etc. — used for precise state interpretation without over-claiming.
  const actionDetailVerdict: string | null = isReadinessForSelectedJob
    ? (sniperRunState?.lastPreflightSnapshot?.actionDetail?.verdict ?? null)
    : null

  const nowCardState: NowCardState = deriveNowCardState({
    isBooked,
    lastResult:               job?.last_result ?? null,
    bookingActive:            bgReadiness?.armed?.state === 'booking',
    phase,
    effectivePreflightStatus,
    localArmed,
    lastFailedAction,
    domActionState:           isReadinessForSelectedJob ? (bgReadiness?.action ?? null) : null,
    actionDetailVerdict,
  })

  // Stage 3 / Stage 6: single smart button config — drives the IDLE action button + helper text
  // isWaitlistScenario: class is full AND a waitlist button is visible → bot will join the waitlist.
  //   NOTE: effectivePreflightStatus === 'full' is excluded — that means "full, NO waitlist button"
  //   (e.g. "Closed - Full" only), where there's no waitlist to join.
  const isWaitlistScenario =
    effectivePreflightStatus === 'waitlist_only' ||
    actionDetailVerdict      === 'waitlist_only'

  // Stage 6: class is completely full with no waitlist button visible.
  // Distinct from isWaitlistScenario — no action the bot can take here.
  const isClassFull = effectivePreflightStatus === 'full'

  const smartButton: SmartButtonConfig = resolveSmartButton({
    cardState:    nowCardState,
    countdown,
    bookingOpenMs,
    nextWindow:   bgReadiness?.armed?.nextWindow ?? null,
    isWaitlistScenario,
    isClassFull,
  })

  // Secondary action state — drives the dynamic label + sheet contents.
  // Derived from the same signals as smartButton; no extra API calls needed.
  const secondaryAction: SecondaryActionState = resolveSecondaryAction({
    nowCardState,
    confidenceLabel,
    compositeColor: composite.color,
    localArmed,
    bgSession:   reconciledBgSession,
    bgDiscovery: isReadinessForSelectedJob ? (bgReadiness?.discovery ?? null) : null,
  })

  // Label and context-aware action sheet rows driven by secondaryAction.
  const SECONDARY_LABEL: Record<SecondaryActionState, string> = {
    options: 'Options',
    check:   'Check',
    ready:   'Ready',
    fix:     'Fix',
    status:  'Status',
  }

  // Action sheet rows change based on the assistant's read of the situation.
  const secondarySheetItems: { label: string; sub: string; handler: () => void }[] = (() => {
    switch (secondaryAction) {
      case 'check':
        return [
          { label: 'Run Registration Check', sub: 'Verify session, class, and registration', handler: handleNowPreflight },
          { label: 'Register Now',            sub: 'Attempt immediate registration',         handler: handleNowBook       },
          { label: 'Auto-register',           sub: 'Set up auto-registration for when the window opens', handler: handleNowPreflight },
        ]
      case 'fix':
        return [
          { label: 'Run Registration Check', sub: 'Verify session, class, and registration', handler: handleNowPreflight },
          { label: 'Retry Registration',     sub: 'Attempt registration again',              handler: handleNowBook       },
          { label: 'Auto-register',          sub: 'Set up auto-registration for when the window opens', handler: handleNowPreflight },
        ]
      case 'ready':
      case 'status':
      case 'options':
      default:
        return [
          { label: 'Register Now',       sub: 'Attempt immediate registration',              handler: handleNowBook       },
          { label: 'Auto-register',      sub: 'Set up auto-registration for when the window opens', handler: handleNowPreflight },
          { label: 'Registration Check', sub: 'Verify session, class, and registration',     handler: handleNowPreflight },
        ]
    }
  })()

  // Confidence summary — rendered below the persistent armed checklist.
  // Only computed when localArmed so it's only needed while the checklist is visible.
  const confidenceSummary: ConfidenceSummary | null = localArmed
    ? resolveConfidenceSummary({
        nowCardState,
        compositeColor:       composite.color,
        compositeStatus:      composite.status,
        confidenceLabel,
        bgSession:            reconciledBgSession,
        bgDiscovery:          isReadinessForSelectedJob ? (bgReadiness?.discovery ?? null) : null,
        sessionFailureType:   sessionStatus?.failureType ?? null,
        isClassFull,
      })
    : null

  if (loading) {
    return (
      <>
        <AppHeader subtitle="Loading…" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} tab={tab} onTabChange={onTabChange} scrolled={scrolled} />
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
        <AppHeader subtitle="Error" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} tab={tab} onTabChange={onTabChange} scrolled={scrolled} />
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
        tab={tab}
        onTabChange={onTabChange}
        scrolled={scrolled}
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
                {appState.jobs.length === 0
                  ? 'Add a class in the Plan tab to get started.'
                  : 'Tap a class in the Plan tab to watch it.'}
              </p>
            </div>
          )}

          {/* Status banner — booked / waitlist / off / sniper / late / countdown.
               Urgency states (Registering, Armed ≤45s) keep tinted surfaces to
               signal action. Calm states (Registered, Late, Off) use flat dot+text
               so the card doesn't feel like nested boxes. */}
          {isBooked ? (
            job?.last_result === 'waitlist' ? (
              // Waitlisted — amber surface, mild warning
              <div className="flex items-center gap-2.5 py-0.5">
                <StatusDot color="amber" />
                <span className="text-[17px] font-semibold text-amber-600">Waitlisted</span>
              </div>
            ) : (
              // Registered — flat green, calm completion state
              <div className="flex items-center gap-2.5 py-0.5">
                <StatusDot color="green" />
                <span className="text-[17px] font-semibold text-accent-green">
                  {job?.last_result === 'dry_run' ? 'Test run' : 'Registered'}
                </span>
              </div>
            )
          ) : actionDetailVerdict === 'cancel_only' ? (
            // DOM shows only a cancel button — most likely already registered outside this bot.
            // DB hasn't recorded the booking (e.g. manual registration). Show a soft confirmation
            // without claiming the class is full or that registration is unavailable.
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="green" />
              <span className="text-[17px] font-semibold text-accent-green">You're already registered</span>
            </div>
          ) : isInactive ? (
            // Scheduling off — flat, no surface box
            <div className="py-0.5">
              <div className="flex items-center gap-2.5">
                <StatusDot color="gray" />
                <span className="text-[16px] text-text-secondary">Scheduling off</span>
              </div>
              <p className="text-[12px] text-text-muted mt-1 ml-[22px]">
                Turn this class on in the Plan tab to resume registration
              </p>
            </div>
          ) : phase === 'sniper' && nowCardState === 'registration_open_full' ? (
            // Window open but class is full — show waitlist or full-no-waitlist banner.
            // Suppress blue "Registering…" which implies spots.
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="amber" />
              <span className="text-[16px] font-semibold text-amber-600">
                {isClassFull ? 'Class is full' : 'Class is full · Waitlist available'}
              </span>
            </div>
          ) : phase === 'sniper' ? (
            // Actively registering — keep blue tint (urgency)
            <div className="bg-accent-blue/10 rounded-2xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">Registering…</span>
            </div>
          ) : bgReadiness?.executionTiming?.phase === 'confirming' ? (
            // Stage 10E — booking in flight, waiting for confirmation
            <div className="bg-accent-blue/10 rounded-2xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">Confirming registration…</span>
            </div>
          ) : phase === 'late' && bgReadiness?.armed?.state === 'booking' ? (
            // Booking running in late phase — keep blue (active)
            <div className="bg-accent-blue/10 rounded-2xl px-4 py-3 flex items-center gap-2.5">
              <StatusDot color="blue" />
              <span className="text-[17px] font-semibold text-accent-blue">Registering…</span>
            </div>
          ) : phase === 'late' && nowCardState === 'registration_open_full' ? (
            // Past window — class full; distinguish waitlist available vs no waitlist
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="amber" />
              <span className="text-[16px] font-semibold text-amber-600">
                {isClassFull ? 'Class is full' : 'Class is full · Waitlist available'}
              </span>
            </div>
          ) : phase === 'late' && nowCardState === 'registration_open_with_spots' ? (
            // Past window but DOM confirms spots still available (rare but possible)
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="blue" />
              <span className="text-[16px] font-semibold text-accent-blue">Registration is open</span>
            </div>
          ) : phase === 'late' && effectivePreflightStatus === 'not_found' ? (
            // Class wasn't found on the schedule — window is past but the mismatch
            // deserves a more specific message than "Registration has closed".
            // User may need to update the class name or check the YMCA schedule.
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="amber" />
              <span className="text-[16px] text-text-secondary">Class not found on schedule</span>
            </div>
          ) : phase === 'late' ? (
            // Truly closed — no actionable path remaining
            <div className="flex items-center gap-2.5 py-0.5">
              <StatusDot color="gray" />
              <span className="text-[16px] text-text-secondary">Registration has closed</span>
            </div>
          ) : execPhase === 'armed' ? (
            // Stage 10H — ≤45 s to open; amber keeps urgency
            <div className="bg-accent-amber/10 rounded-2xl px-4 py-3">
              <div className="flex items-center gap-2.5 mb-1">
                <StatusDot color="amber" />
                <span className="text-[17px] font-semibold text-accent-amber">Opening in</span>
              </div>
              <div className="ml-[22px]">
                <span className="text-[36px] font-bold text-accent-amber tabular-nums leading-none tracking-tighter">
                  {countdown
                    ? countdown.split('').map((ch, i) => (
                        <span key={`a-${i}-${ch}`} className="inline-block animate-digit-in">{ch}</span>
                      ))
                    : '—'}
                </span>
              </div>
            </div>
          ) : (
            // Default countdown — no inner box, number floats on card bg
            <div className="pt-0.5 pb-4">
              <span className="text-[48px] font-bold text-text-primary tabular-nums leading-none tracking-tighter">
                {countdown
                  ? countdown.split('').map((ch, i) => (
                      <span key={`d-${i}-${ch}`} className="inline-block animate-digit-in">{ch}</span>
                    ))
                  : '—'}
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

          {/* ── Cancel registration button — shown when booked/waitlisted ─────── */}
          {isBooked && execMode === 'idle' && job && (
            <div className="mt-2">
              {cancelResult && (
                <div className={`rounded-xl px-3.5 py-2.5 mb-2 ${cancelResult.ok ? 'bg-accent-green/10' : 'bg-accent-red/10'}`}>
                  <p className={`text-[13px] font-medium ${cancelResult.ok ? 'text-accent-green' : 'text-accent-red'}`}>
                    {cancelResult.ok ? '✓ ' : '✗ '}{cancelResult.text}
                  </p>
                  {!cancelResult.ok && (
                    <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
                      Already cancelled on the YMCA site?{' '}
                      <button
                        onClick={async () => {
                          if (!job) return
                          try { await api.resetBooking(job.id); refresh(); setCancelResult(null) } catch { /* ignored */ }
                        }}
                        className="text-accent-blue underline active:opacity-60"
                      >
                        Clear status
                      </button>
                    </p>
                  )}
                </div>
              )}
              <button
                onClick={() => { setCancelResult(null); setShowCancelSheet(true) }}
                disabled={cancelInProgress}
                className="w-full rounded-xl py-2.5 text-[14px] font-medium border border-accent-red/40 text-accent-red active:opacity-60 transition-opacity disabled:opacity-40"
              >
                {cancelInProgress
                  ? 'Cancelling…'
                  : job.last_result === 'waitlist'
                    ? 'Leave Waitlist'
                    : 'Cancel Registration'}
              </button>
              {cancelInProgress && (
                <p className="text-[11px] text-text-muted text-center mt-1.5 leading-snug">
                  Connecting to YMCA — this usually takes 30–60 seconds
                </p>
              )}
            </div>
          )}

          {/* ── Now-tab: checklist + action buttons ────────────────────── */}
          {job && (
            <div className="mt-3">

              {/* ═══ Unified preflight checklist ══════════════════════════════════
                   Always visible for preflight states (idle, running_preflight,
                   and done-after-preflight). Replaces three separate blocks
                   (armed-idle checklist / not-armed result banner / running steps).
                   Hidden only during an active booking run/result. */}
              {!isBooked && !isBookingFlow && (
                <div className="mb-3">
                  <p className="text-[12px] text-text-secondary mb-3">
                    Registration readiness
                  </p>

                  {/* Step rows — icon spans are keyed on `step+status` so
                       React remounts the icon (and replays animate-checklist-icon)
                       only when the status actually changes, not on every render. */}
                  <div className="space-y-3 mt-1">
                    {PREFLIGHT_CHECKLIST_STEPS.map(step => {
                      // Derive per-row status from live exec state + armed flag
                      const status: StepStatus = (() => {
                        if (step === 'confirmed') {
                          // Virtual final step: armed → success; active only after
                          // all 4 real steps have completed so it progresses naturally
                          // in sequence rather than activating from the start.
                          if (localArmed) return 'success'
                          if (execMode === 'running_preflight' && execSteps['modal'] === 'success')
                            return 'running'
                          return 'pending'
                        }
                        // When armed, all real steps are confirmed green
                        if (localArmed) return 'success'
                        // Otherwise use live execSteps (pending/running/success/failed)
                        return execSteps[step]
                      })()

                      // 'confirmed' changes its label while actively being checked,
                      // and also when the class is known to be full (waitlist path).
                      const label =
                        step === 'confirmed' && status === 'running'
                          ? (isWaitlistScenario ? 'Confirming waitlist access…' : 'Confirming registration access…')
                          : step === 'confirmed' && isWaitlistScenario
                          ? 'Waitlist path confirmed'
                          : STEP_LABELS[step]

                      const icon =
                        status === 'success' ? '✓' :
                        status === 'failed'  ? '✗' :
                        status === 'running' ? '⏳' : '·'

                      const iconClass =
                        status === 'success' ? 'text-accent-green' :
                        status === 'failed'  ? 'text-accent-red'   :
                        status === 'running' ? 'text-accent-blue'  :
                        'text-text-muted'

                      const textClass =
                        status === 'pending' ? 'text-text-muted'               :
                        status === 'failed'  ? 'text-accent-red'               :
                        status === 'running' ? 'text-text-primary font-medium' :
                        'text-text-primary'

                      return (
                        <div key={step} className="flex items-center gap-3">
                          {/* key includes status → remounts icon on state change
                               → animate-checklist-icon replays (180ms fade-in) */}
                          <span
                            key={`icon-${step}-${status}`}
                            className={`text-[14px] w-4 text-center shrink-0 leading-none select-none animate-checklist-icon ${iconClass}`}
                          >
                            {icon}
                          </span>
                          <span className={`text-[14px] ${textClass}`}>{label}</span>
                        </div>
                      )
                    })}

                    {/* ── Standby row — "Waiting for registration window" ────────────
                         Appears only when armed + idle + window not yet open + no failure.
                         The pulsing dot is the ONLY animated element; text is fully stable.
                         Removed when: window opens (phase→sniper), registration runs/fails,
                         disarmed, or the class is registered. */}
                    {showStandbyRow && (
                      <div className="flex items-center gap-3">
                        {/* Pulse container — fixed 16px to match icon column */}
                        <span className="w-4 shrink-0 flex items-center justify-center">
                          <span className="animate-standby-pulse inline-block w-1.5 h-1.5 rounded-full bg-accent-amber" />
                        </span>
                        <span className="text-[14px] text-text-muted">
                          Waiting for registration window
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Error detail — shown below the failed row when check failed */}
                  {lastFailedAction === 'preflight' && execDone && !execDone.ok && (
                    <div className="mt-2 pl-7">
                      <p className="text-[12px] text-accent-red/90 leading-snug">{execDone.text}</p>
                    </div>
                  )}

                  {/* Confidence + timing — shown when armed */}
                  {localArmed && confidenceSummary && (() => {
                    const { level, label: confLabel, reason } = confidenceSummary
                    const labelClass =
                      level === 'very_likely'       ? 'text-accent-green' :
                      level === 'needs_attention'   ? 'text-accent-amber' :
                      level === 'check_recommended' ? 'text-accent-amber' :
                      'text-text-secondary'
                    const nextWindow = bgReadiness?.armed?.nextWindow ?? null
                    const timeStr    = nextWindow ? fmtWindowTime(nextWindow) : null
                    const showTiming =
                      level !== 'check_recommended' && level !== 'needs_attention'
                    return (
                      <div
                        className="mt-3 pt-3 border-t border-divider/20 animate-fade-in-up"
                        style={{ animationDelay: '150ms' }}
                      >
                        <p className={`text-[13px] font-medium leading-snug ${labelClass}`}>
                          {confLabel}
                        </p>
                        {/* Only show timing when we have a concrete window time.
                             The "waiting" message is already carried by the standby
                             row above; duplicating it here adds noise. */}
                        {showTiming && timeStr && (
                          <p className="text-[12px] text-text-muted mt-0.5 leading-snug">
                            {isWaitlistScenario
                              ? `Will join waitlist at ${timeStr}`
                              : `Will register at ${timeStr}`}
                          </p>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* IDLE: Stage 3/4 — smart primary button + subtle overflow trigger */}
              {execMode === 'idle' && (() => {
                const { label, actionType, helperText, disabled, emphasis } = smartButton

                // Map actionType → handler (register and waitlist share the same
                // backend flow — handleNowBook detects which button to click)
                const handler =
                  actionType === 'register' ? handleNowBook      :
                  actionType === 'waitlist' ? handleNowBook      :
                  actionType === 'arm'      ? handleNowPreflight :
                  actionType === 'disarm'   ? handleDisarm       :
                  undefined

                // Derive button classes from emphasis + disabled state.
                // flex-1 so the Options button sits alongside it at a fixed width.
                // transition-[transform,opacity] + duration-150 = iOS-native spring press feel:
                //   press down snaps fast (instant to 0.97 scale while finger is held),
                //   release eases back in 150ms — feels physical without being heavy.
                const btnClass = [
                  'flex-1 rounded-2xl py-3 text-[15px] font-semibold transition-[transform,opacity] duration-150 ease-out',
                  disabled
                    ? emphasis === 'muted'
                      ? 'bg-surface border border-divider text-text-muted cursor-default'
                      : 'bg-accent-blue text-white opacity-60 cursor-default'
                    : emphasis === 'primary-amber'
                      ? 'bg-accent-amber text-white shadow-sm active:scale-[0.97] active:opacity-90'
                      : emphasis === 'outline-red'
                        ? 'bg-accent-red/[0.06] border border-accent-red/20 text-accent-red/80 active:scale-[0.97] active:opacity-80'
                        : 'bg-accent-blue text-white shadow-sm active:scale-[0.97] active:opacity-90',
                ].join(' ')

                // Long-press handlers — fires the action sheet after 500 ms hold.
                // Cancelled on touch-end / touch-move so normal taps are unaffected.
                const onLongPressStart = () => {
                  if (disabled) return
                  longPressTimerRef.current = setTimeout(() => {
                    longPressTimerRef.current = null
                    setShowActionSheet(true)
                  }, 500)
                }
                const onLongPressCancel = () => {
                  if (longPressTimerRef.current) {
                    clearTimeout(longPressTimerRef.current)
                    longPressTimerRef.current = null
                  }
                }

                // ── Guard overlay — shown when a live preflight check is in progress
                // or has returned a non-success result that needs user acknowledgement.
                if (guardState !== null) {
                  return (
                    <div className="space-y-2.5">
                      {guardState === 'checking' && (
                        <div className="rounded-2xl bg-surface border border-divider px-4 py-3 flex items-center gap-2.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse shrink-0" />
                          <span className="text-[14px] text-text-secondary">Checking registration status…</span>
                        </div>
                      )}
                      {guardState === 'waitlist_only' && (
                        <>
                          <div className="rounded-2xl bg-accent-amber/10 border border-accent-amber/20 px-4 py-3 flex items-start gap-2.5">
                            <span className="mt-0.5 shrink-0"><StatusDot color="amber" /></span>
                            <div>
                              <p className="text-[14px] font-medium text-amber-700">{guardMessage}</p>
                              <p className="text-[12px] text-text-muted mt-0.5">Tap "Join Waitlist" to be added if a spot opens.</p>
                            </div>
                          </div>
                          <div className="flex items-stretch gap-2">
                            <button
                              onClick={handleGuardJoinWaitlist}
                              className="flex-1 rounded-2xl py-3 text-[15px] font-semibold bg-accent-amber text-white shadow-sm active:scale-[0.97] active:opacity-90 transition-[transform,opacity] duration-150 ease-out"
                            >
                              Join Waitlist
                            </button>
                            <button
                              onClick={handleGuardCancel}
                              className="flex-shrink-0 min-w-[5.5rem] px-4 flex items-center justify-center rounded-2xl bg-text-primary/[0.06] text-[14px] font-medium text-text-primary active:scale-[0.97] active:opacity-70 transition-[transform,opacity] duration-150 ease-out"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                      {guardState === 'blocked' && (
                        <>
                          <div className="rounded-2xl bg-accent-red/[0.07] border border-accent-red/20 px-4 py-3 flex items-start gap-2.5">
                            <span className="mt-0.5 shrink-0"><StatusDot color="red" /></span>
                            <p className="text-[14px] font-medium text-accent-red">{guardMessage}</p>
                          </div>
                          <button
                            onClick={handleGuardCancel}
                            className="w-full rounded-2xl py-3 text-[15px] font-semibold bg-text-primary/[0.06] text-text-primary active:scale-[0.97] active:opacity-70 transition-[transform,opacity] duration-150 ease-out"
                          >
                            OK
                          </button>
                        </>
                      )}
                    </div>
                  )
                }

                return (
                  <div>
                    <div className="flex items-stretch gap-2">
                      {/* Primary action — long-press also opens Options sheet */}
                      <button
                        onClick={handler}
                        disabled={disabled}
                        className={btnClass}
                        onTouchStart={onLongPressStart}
                        onTouchEnd={onLongPressCancel}
                        onTouchMove={onLongPressCancel}
                      >
                        {label}
                      </button>
                      {/* Secondary / Options button — label is context-driven.
                           Hidden when primary is disabled (booked / in-progress)
                           so the sheet can't offer contradictory actions. */}
                      {!disabled && (
                        <button
                          onClick={() => setShowActionSheet(true)}
                          className="flex-shrink-0 min-w-[5.5rem] px-4 flex items-center justify-center rounded-2xl bg-text-primary/[0.06] text-[14px] font-medium text-text-primary active:scale-[0.97] active:opacity-70 transition-[transform,opacity] duration-150 ease-out"
                          aria-label={SECONDARY_LABEL[secondaryAction]}
                        >
                          {SECONDARY_LABEL[secondaryAction]}
                        </button>
                      )}
                    </div>
                    {/* helperText suppressed when armed — status message in the
                         checklist block already shows timing ("Will register at X"). */}
                    {helperText && !localArmed && (
                      <p className="text-center text-[12px] text-text-muted mt-1.5 leading-snug">
                        {helperText}
                      </p>
                    )}
                  </div>
                )
              })()}

              {/* BOOKING RUNNING: 6-step list + pulse — preflight is handled by
                   the unified checklist above (confirmed row becomes active). */}
              {execMode === 'running_booking' && (
                <div>
                  <p className="text-[12px] font-medium text-text-muted mb-2.5">Registering…</p>
                  <div className="space-y-2">
                    {execStepList.map(step => {
                      const status = execSteps[step]
                      const icon =
                        status === 'success' ? '✓' :
                        status === 'failed'  ? '✗' :
                        status === 'running' ? '⏳' : '⬜'
                      const textClass =
                        status === 'pending' ? 'text-text-muted' :
                        status === 'failed'  ? 'text-accent-red' :
                        status === 'running' ? 'text-text-primary font-medium' :
                        'text-text-primary'
                      return (
                        <div key={step} className="flex items-center gap-2.5">
                          <span className="text-[13px] w-4 text-center shrink-0 tabular-nums">{icon}</span>
                          <span className={`text-[13px] ${textClass}`}>{STEP_LABELS[step]}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse shrink-0" />
                    <span className="text-[12px] text-text-muted">Submitting registration…</span>
                  </div>
                </div>
              )}

              {/* BOOKING DONE: result banner + retry — shown only after a booking run */}
              {execMode === 'done' && isBookingFlow && execDone && (
                <div>
                  <div className="space-y-1.5 mb-2.5">
                    {execStepList.map(step => {
                      const status = execSteps[step]
                      const icon = status === 'success' ? '✓' : status === 'failed' ? '✗' : '⬜'
                      const textClass =
                        status === 'pending' ? 'text-text-muted' :
                        status === 'failed'  ? 'text-accent-red' :
                        'text-text-primary'
                      return (
                        <div key={step} className="flex items-center gap-2.5">
                          <span className="text-[13px] w-4 text-center shrink-0 tabular-nums">{icon}</span>
                          <span className={`text-[13px] ${textClass}`}>{STEP_LABELS[step]}</span>
                        </div>
                      )
                    })}
                  </div>
                  <div className={`rounded-xl px-3.5 py-2.5 ${
                    execDone.color === 'green' ? 'bg-accent-green/10 border border-accent-green/20' :
                    execDone.color === 'amber' ? 'bg-accent-amber/10 border border-accent-amber/20' :
                    'bg-accent-red/10 border border-accent-red/20'
                  }`}>
                    <div className="flex items-center gap-2">
                      <StatusDot color={execDone.color === 'green' ? 'green' : execDone.color === 'amber' ? 'amber' : 'red'} />
                      <p className={`text-[14px] font-medium ${
                        execDone.color === 'green' ? 'text-accent-green' :
                        execDone.color === 'amber' ? 'text-accent-amber' :
                        'text-accent-red'
                      }`}>{execDone.text}</p>
                    </div>
                  </div>
                  {!execDone.ok && (
                    <button
                      onClick={handleNowBook}
                      className="mt-2 w-full py-2 rounded-2xl border border-divider text-[13px] text-text-secondary font-medium active:opacity-60 active:scale-[0.98] transition-all"
                    >
                      Retry registration
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Actions section — spacing only, no divider border */}
          {job && (
            <div className="mt-7">

              {/* ── Bottom utility row: Live/Test toggle + Pause/Resume ───────────── */}
              {/* Resume is shown as an amber pill (urgent); Pause is muted text.    */}
              {/* Live/Test is always visible; Pause/Resume only when banner active.  */}
              <div className="flex items-center justify-between px-1">
                {/* Live / Test toggle — left side */}
                <div className="flex items-center gap-0.5 text-[11px]">
                  <button
                    onClick={() => handleDryRun(false)}
                    className={`px-2 py-1 rounded-md transition-all
                      ${!appState.dryRun
                        ? 'bg-surface font-medium text-text-secondary'
                        : 'text-text-muted'}`}
                  >
                    Live
                  </button>
                  <span className="text-text-muted opacity-30 select-none">/</span>
                  <button
                    onClick={() => handleDryRun(true)}
                    className={`px-2 py-1 rounded-md transition-all
                      ${appState.dryRun
                        ? 'bg-surface font-medium text-text-secondary'
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

        {/* ── Contextual Tools link — only surfaces when the assistant signals an issue.
             Hidden when everything is healthy so the screen stays clean.
             "check" = low confidence / session error / class missing (before arming)
             "fix"   = last action failed (registration_failed / preflight_failed)  */}
        {!isBooked && onGoToTools && (secondaryAction === 'check' || secondaryAction === 'fix') && (
          <div className="text-center">
            <button
              onClick={() => onGoToTools('tools-readiness')}
              className="text-[12px] text-text-muted active:opacity-50 px-2 py-1"
            >
              View details in Tools →
            </button>
          </div>
        )}

        {/* ── Stage 5: Last activity summary — single line, minimal weight.
             Priority: preflight snapshot (when more recent) > latest milestone event.
             This keeps the checklist and "Last activity" in sync — both reflect the
             same run, so they never show contradictory failure reasons. */}
        {sniperRunState && (() => {
          const snap    = sniperRunState.lastPreflightSnapshot
          const entries = [...sniperRunState.events].reverse().filter(isMilestoneEvent)
          const latest  = entries[0]

          // Use the snapshot when it's more recent than the latest milestone event.
          // ISO timestamps sort lexicographically so string comparison is valid.
          const snapIsNewer = snap?.checkedAt && (!latest || snap.checkedAt > latest.timestamp)

          // Resolve label, failure flag, and timestamp from whichever source is newer.
          const resolved: { label: string; isFailure: boolean; ts: string } | null = (() => {
            if (snapIsNewer && snap) {
              const s = snap.status
              const label =
                s === 'success'           ? 'Ready to register'             :
                s === 'waitlist_only'     ? 'Class is full — waitlist open' :
                s === 'found_not_open_yet'? 'Registration window not open'  :
                s === 'not_found'         ? 'Class not found on schedule'   :
                s === 'full'              ? 'Class is full — no spots available' :
                s === 'closed'            ? 'Registration is closed'        :
                                            'Registration check failed'
              const isFailure = s !== 'success' && s !== 'waitlist_only' && s !== 'found_not_open_yet'
              return { label, isFailure, ts: snap.checkedAt }
            }
            if (latest) {
              return { label: friendlyEventLabel(latest), isFailure: !!latest.failureType, ts: latest.timestamp }
            }
            return null
          })()
          if (!resolved) return null
          const { label, isFailure, ts: activityTs } = resolved

          const timeStr = (() => {
            try { return new Date(activityTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
            catch { return null }
          })()
          return (
            <p className={`text-center text-[12px] px-4 ${isFailure ? 'text-accent-red/70' : 'text-text-muted'}`}>
              Last activity: {label}{timeStr ? ` at ${timeStr}` : ''}
            </p>
          )
        })()}

        {/* ── Contextual action: Register again ──────────────────── */}
        {isStaleBooking && job && (
          <SecondaryButton
            onClick={handleBookAgain}
            disabled={resetting}
            className="w-full"
          >
            {resetting ? 'Resetting…' : 'Register again'}
          </SecondaryButton>
        )}

      </ScreenContainer>

      {/* ── Stage 4: Advanced action sheet (progressive disclosure) ─────────
           Shown over the entire screen via fixed positioning.
           Options reuse existing handlers; sheet auto-closes when execMode
           leaves 'idle' (i.e. as soon as any action starts).              */}
      {showActionSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={() => setShowActionSheet(false)}
        >
          {/* scrim */}
          <div className="absolute inset-0 bg-black/40" />

          {/* bottom sheet */}
          <div
            className="relative w-full bg-white rounded-t-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* title */}
            <div className="px-4 py-3.5 border-b border-divider">
              <p className="text-center text-[13px] font-semibold text-text-secondary tracking-wide">
                {job?.class_title ?? 'Actions'}
              </p>
            </div>

            {/* action rows — context-driven via secondarySheetItems */}
            {secondarySheetItems.map(item => (
              <button
                key={item.label}
                onClick={() => { setShowActionSheet(false); item.handler() }}
                className="w-full px-5 py-4 flex items-center justify-between border-b border-divider last:border-0 active:bg-surface transition-colors text-left"
              >
                <div>
                  <p className="text-[16px] font-medium text-text-primary leading-snug">
                    {item.label}
                  </p>
                  <p className="text-[12px] text-text-muted mt-0.5 leading-snug">
                    {item.sub}
                  </p>
                </div>
                <svg
                  className="w-4 h-4 flex-shrink-0 ml-3 text-text-muted"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              </button>
            ))}

            {/* cancel */}
            <button
              onClick={() => setShowActionSheet(false)}
              className="w-full py-4 text-center text-[16px] font-semibold text-accent-red active:opacity-60 transition-opacity border-t border-divider mt-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Cancel confirmation sheet ─────────────────────────────────────────
           iOS-style bottom sheet requiring explicit confirmation before cancel.
           Scrim prevents accidental tap-through.                               */}
      {showCancelSheet && job && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={() => setShowCancelSheet(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative w-full bg-white rounded-t-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* header */}
            <div className="px-5 pt-5 pb-3">
              <p className="text-[17px] font-semibold text-text-primary text-center leading-snug">
                {job.last_result === 'waitlist' ? 'Leave Waitlist?' : 'Cancel Registration?'}
              </p>
              <p className="text-[13px] text-text-secondary text-center mt-2 leading-snug">
                You are about to {job.last_result === 'waitlist' ? 'leave the waitlist for' : 'cancel your spot in'}:
              </p>
              <p className="text-[13px] font-medium text-text-primary text-center mt-0.5 leading-snug">
                {job.class_title}
                {job.class_time ? ` · ${job.class_time}` : ''}
              </p>
              <p className="text-[11px] text-text-muted text-center mt-1 leading-snug">
                This action will be performed on the YMCA website.
              </p>
            </div>

            <div className="border-t border-divider mt-1">
              {/* confirm — red */}
              <button
                onClick={handleCancelConfirm}
                className="w-full py-4 text-center text-[17px] font-semibold text-accent-red active:opacity-60 transition-opacity border-b border-divider"
              >
                {job.last_result === 'waitlist' ? 'Leave Waitlist' : 'Cancel Registration'}
              </button>
              {/* keep — default */}
              <button
                onClick={() => setShowCancelSheet(false)}
                className="w-full py-4 text-center text-[17px] font-medium text-accent-blue active:opacity-60 transition-opacity"
              >
                Keep Reservation
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
