export type Phase = 'too_early' | 'warmup' | 'sniper' | 'late' | 'unknown'

export type DaxkoStatus      = 'DAXKO_READY' | 'AUTH_NEEDS_LOGIN' | 'AUTH_UNKNOWN'
export type FamilyWorksStatus= 'FAMILYWORKS_READY' | 'FAMILYWORKS_SESSION_MISSING' | 'AUTH_UNKNOWN'
export type OverallAuthStatus= 'DAXKO_READY' | 'FAMILYWORKS_READY' | 'FAMILYWORKS_SESSION_MISSING' | 'AUTH_NEEDS_LOGIN' | 'AUTH_UNKNOWN'

export type AuthStatusEnum = 'connected' | 'needs_refresh' | 'recovering' | 'signed_out'

// ── Stage 1: Separated state models ───────────────────────────────────────────
// Connection truth — what the session actually is, independent of what operation
// is currently running.
export type ConnectionState = 'connected' | 'needs_attention' | 'unknown'

// Operation state — what auth-related action is currently in flight, if any.
// Secondary to connection truth; should not override the settled headline.
// refreshing = background session reuse/revalidation (no credentials needed)
// signing_in = full credential-based login (Daxko + FamilyWorks OAuth)
export type OperationState =
  | 'idle'
  | 'signing_in'
  | 'refreshing'
  | 'verifying'
  | 'blocked_by_booking'
  | 'failed'

export interface AuthState {
  status:                   AuthStatusEnum
  daxkoValid:               boolean
  familyworksValid:         boolean
  bookingAccessConfirmed:   boolean     // schedule embed reachable + booking surface verified
  bookingAccessConfirmedAt: number | null  // ms epoch — null = never confirmed
  lastCheckedAt:            number | null
  lastRecoveredAt:          number | null
  isAuthInProgress:         boolean
  authOperation:            'signing_in' | 'refreshing' | 'verifying' | 'recovery' | null
}

export interface SessionStatus {
  valid:         boolean | null
  failureType?:  'timeout' | 'auth_failed' | null
  checkedAt:     string | null
  detail:        string | null
  screenshot:    string | null
  daxko:         DaxkoStatus
  familyworks:   FamilyWorksStatus
  overall:       OverallAuthStatus
  lastVerified:  string | null
  locked?:       boolean
  bookingActive?: boolean   // true when a booking run is currently in flight
  authState?:    AuthState
}
export type LastResult =
  | 'booked'
  | 'found_not_open_yet'
  | 'not_found'
  | 'error'
  | 'skipped'
  | 'dry_run'
  | null

export type BookingStatus = 'monitoring' | 'opening_soon' | 'booking_now' | 'booked' | 'paused' | 'error'

export interface Job {
  id: number
  class_title: string
  day_of_week: string
  class_time: string
  instructor: string | null
  target_date: string | null
  is_active: boolean
  last_run_at: string | null
  last_result: LastResult
  last_error_message: string | null
  last_success_at: string | null
  created_at: string
  // Enriched by /api/state
  phase?: Phase
  bookingOpenMs?: number | null
  // True for one-off jobs (target_date set) whose class date+time is already
  // in the past.  When set, the scheduler skips the job and the Plan card
  // shows an "advance to next week" prompt instead of the stale countdown.
  passed?: boolean
  // Task #66 — number of times this one-off job has been advanced via the
  // "Advance to next week" prompt without being dismissed/converted.  Reset
  // to 0 on conversion to recurring.  When >= 2 and not dismissed, the Plan
  // card surfaces a "Make this weekly?" suggestion alongside the banner.
  advance_count?: number
  // Per-job dismissal of the "Make this weekly?" suggestion.  Stored as 0/1
  // in SQLite/PG so it travels through pg-sync as a number, not a boolean.
  weekly_suggest_dismissed?: number | boolean
  weekdayConsistency?: {
    isConsistent: boolean
    storedWeekday: string | null
    computedWeekday: string | null
    mismatchReason: string | null
  }
  // Task #70 — schedule_not_loaded backoff state.  Present (non-null) only
  // when at least one consecutive `schedule_not_loaded` failure has been
  // recorded for this job in this process.  inBackoff=true means the
  // scheduler is skipping this job until backoffUntilMs.
  scheduleBackoff?: {
    inBackoff: boolean
    consecutive: number
    backoffUntilMs: number
    retryInMs: number
    nearOpenLifted?: boolean
  } | null
  // Stage 7: live-truth visibility (only populated for active sniper/late jobs)
  liveAvailability?: {
    state: 'bookable' | 'waitlist_available' | 'full' | 'cancelled' | 'unknown' | 'not_found'
    openSpots?: number | null
    totalCapacity?: number | null
    reason?: string | null
    fetchedAt?: string | null
    ageMs?: number | null
  } | null
  liveVerdict?: {
    verdict: 'open' | 'waitlist' | 'full' | 'cancelled' | 'unknown'
    isFresh: boolean
    ageMs: number | null
    openSpots?: number | null
    reason?: string
  } | null
  liveUrgencyHints?: {
    preemptBufferDeltaMs: number
    burstDelayMultiplier: number
    source: 'live-truth' | 'fallback'
    reason: string
  } | null
  liveRecentInfluence?: {
    urgency?: {
      atMs: number
      reason: string
      preemptBufferDeltaMs: number
      burstDelayMultiplier: number
      baseDelayMs: number
      adjustedDelayMs: number
    }
    acceleration?: {
      atMs: number
      beforeMs: number
      afterMs: number
    }
  } | null
  liveImmediateTrigger?: {
    lastFiredAtMs:       number | null
    cooldownActive:      boolean
    cooldownRemainingMs: number
    lastDecision: {
      atMs:           number
      decision:       'fire' | 'skip'
      reason:         string
      transitionAtMs: number
    } | null
  } | null
}

export interface ScrapedClass {
  id: number
  class_title: string
  day_of_week: string
  class_time: string
  instructor: string | null
  scraped_at: string
}

export interface AppState {
  schedulerPaused: boolean
  dryRun: boolean
  jobs: Job[]
}
