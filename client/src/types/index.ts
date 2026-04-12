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
