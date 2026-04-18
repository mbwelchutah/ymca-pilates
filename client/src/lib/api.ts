import type { Job, AppState, ScrapedClass, SessionStatus } from '../types'
import type { ClassTruthResult, CacheFreshness } from './classTruth'
import type { ReadinessBundle, SniperState } from './readinessTypes'
import type { ExecutionPhase, SniperEvent } from './failureTypes'
import type { DurationMs } from './timeUtils'

// Stage 5/6 — canonical confirmed-ready state shape (mirrors src/bot/confirmed-ready.js).
export interface ConfirmedReadyState {
  status:     'confirmed_ready' | 'needs_refresh' | 'needs_attention' | 'unknown';
  auth: {
    daxkoValid:             boolean;
    familyworksValid:       boolean;
    bookingAccessConfirmed: boolean;
    checkedAt:              number | null;
    freshness:              CacheFreshness;
  };
  classTruth: {
    state:              string;         // ClassState value
    checkedAt:          number | null;
    freshness:          CacheFreshness; // per-entry (capturedAt)
    cacheFileFreshness: CacheFreshness; // file-level (savedAt) — Stage 5/7
    source:             string;
    isFuzzyMatch:       boolean;
    confidence:         number;
  };
  preflight: {
    modalConfirmed: boolean;
    checkedAt:      number | null;
    freshness:      CacheFreshness;
  };
  overall: {
    checkedAt:      number | null;
    freshness:      CacheFreshness;
    reason:         string;
    refreshSource?: string;
  };
  /** Epoch ms when the background scheduler last wrote the state file. */
  persistedAt: number | null;
  /** Job ID that was used for class-truth classification. */
  jobId:       number | null;
}

export interface SniperTiming {
  bookingOpenAt:        string           // ISO — when the booking window was scheduled to open
  cardFoundAt:          string | null    // ISO — when the class card appeared in the poll loop
  actionClickAt:        string | null    // ISO — when Register/Waitlist was clicked
  openToCardMs:         number | null    // ms: booking open → class card appeared
  openToClickMs:        number | null    // ms: booking open → action button clicked
  pollAttemptsPostOpen: number           // tab re-clicks that happened at or after open time
}

export interface SniperRunState {
  runId:          string | null
  jobId:          number | null
  phase:          ExecutionPhase | null
  bundle:         ReadinessBundle
  sniperState:    SniperState
  authBlockedAt:  string | null   // set by real booking runs; never by skip events
  timing:         SniperTiming | null
  screenshotPath: string | null
  events:                 SniperEvent[]
  updatedAt:              string | null
  lastPreflightSnapshot: {
    checkedAt:       string
    status:          string
    authDetail:      { verdict: string; provider: string | null; detail: string | null } | null
    discoveryDetail: { found: boolean; matched: string | null; score: string | null; signals: string | null; second: string | null; nearMisses: string | null } | null
    modalDetail:     { verdict: string; detail: string | null; screenshot: string | null; buttonsVisible: string[] | null; modalPreview: string | null } | null
    actionDetail:    { verdict: string; actionState: string | null; actionStateClassified: string | null; buttonsVisible: string[] | null; registerStrategy: string | null; waitlistStrategy: string | null; detail: string | null } | null
  } | null
}

function friendlyHttpError(status: number): string {
  if (status === 502 || status === 503 || status === 504)
    return 'Server is temporarily unavailable — it may be restarting. Try again in a moment.'
  if (status === 404)
    return 'API endpoint not found — the app may still be starting up.'
  if (status >= 500)
    return `Server error (${status}). Please try again.`
  if (status === 401 || status === 403)
    return `Not authorised (${status}).`
  return `Request failed (${status}).`
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error('Could not reach the server — check your connection.')
  }

  if (!res.ok) {
    // Only try to read JSON error details from our own API responses
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        const body = await res.json()
        const msg = body?.error ?? body?.message
        if (msg) throw new Error(String(msg))
      } catch (e) {
        if (e instanceof Error && e.message) throw e
      }
    }
    // HTML error pages (Replit 502, 404, etc.) — show a clean message
    throw new Error(friendlyHttpError(res.status))
  }
  return res.json() as Promise<T>
}

// Maps the short alias keys used by the backend's slowest_phase field to the
// full metric field names used by PHASE_ORDER / lastTimingMetrics on the
// frontend.  Phases not displayed in the per-phase rows (page_load,
// modal_open, first_attempt) are intentionally absent.
export const SLOWEST_PHASE_TO_DISPLAY_KEY: Record<string, string> = {
  auth:          'auth_phase_ms',
  class_find:    'page_ready_to_class_found',
  card_to_click: 'class_found_to_first_click',
  confirmation:  'first_click_to_confirmation',
}

export const api = {
  getState: (): Promise<AppState> => apiFetch('/api/state'),

  getJobs: (): Promise<Job[]> => apiFetch('/api/jobs'),

  addJob: (job: Omit<Job, 'id' | 'last_run_at' | 'last_result' | 'last_error_message' | 'last_success_at' | 'created_at'>): Promise<{ success: boolean; id: number }> =>
    apiFetch('/add-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    }),

  updateJob: (job: Partial<Job> & { id: number }): Promise<{ success: boolean }> =>
    apiFetch('/update-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    }),

  deleteJob: (id: number): Promise<{ success: boolean }> =>
    apiFetch('/delete-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  toggleActive: (id: number): Promise<{ success: boolean; is_active: boolean }> =>
    apiFetch('/toggle-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  // Bumps a one-off job's target_date forward by 7-day steps until it is in
  // the future, and clears any stale per-occurrence run state.  Used by the
  // Plan card's "Advance to next week" prompt when a class has passed.
  advanceJob: (id: number): Promise<{ success: boolean; job: Job }> =>
    apiFetch(`/api/jobs/${id}/advance`, { method: 'POST' }),

  // Task #66 — One-tap conversion of a one-off class to a recurring schedule.
  // Surfaced from the Plan card's "Make this weekly?" suggestion after a class
  // has been advanced 2+ times in succession.  Clears target_date server-side.
  convertJobToRecurring: (id: number): Promise<{ success: boolean; job: Job; error?: string }> =>
    apiFetch(`/api/jobs/${id}/convert-to-recurring`, { method: 'POST' }),

  // Task #66 — Permanently silences the "Make this weekly?" suggestion for
  // this specific job; the prompt won't reappear regardless of future advances.
  dismissWeeklySuggestion: (id: number): Promise<{ success: boolean; error?: string }> =>
    apiFetch(`/api/jobs/${id}/dismiss-weekly-suggestion`, { method: 'POST' }),

  pauseScheduler: (): Promise<{ success: boolean }> =>
    apiFetch('/pause-scheduler', { method: 'POST' }),

  resumeScheduler: (): Promise<{ success: boolean }> =>
    apiFetch('/resume-scheduler', { method: 'POST' }),

  setDryRun: (enabled: boolean): Promise<{ success: boolean }> =>
    apiFetch('/set-dry-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  forceRunJob: (id: number): Promise<{
    success: boolean;
    message: string;
    status?: string | null;
    reason?: string | null;
    phase?: string | null;
  }> =>
    apiFetch(`/force-run-job?id=${id}`, { method: 'POST' }),

  runDryRun: (jobId: number): Promise<{ success: boolean; status: string; message: string; label: string; color: 'green' | 'amber' | 'red' }> =>
    apiFetch('/api/dry-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }),

  runSchedulerOnce: (): Promise<{ success: boolean; message: string }> =>
    apiFetch('/run-scheduler-once', { method: 'POST' }),

  getStatus: (): Promise<{ active: boolean; log: string; success: boolean | null }> =>
    apiFetch('/status'),

  getFailures: (): Promise<{
    recent: Array<{
      id:          number | null
      job_id:      number | null
      occurred_at: string
      phase:       string
      reason:      string
      message:     string | null
      class_title: string | null
      screenshot:  string | null
      category:    string | null
      label:       string | null
      expected:    string | null
      actual:      string | null
      url:         string | null
      context_json: string | null
    }>
    summary:  Record<string, number>
    by_phase: Record<string, number>
    trends: {
      h24: { byReason: Array<{ reason: string; count: number }>; byPhase: Array<{ phase: string; count: number }>; total: number }
      d7:  { byReason: Array<{ reason: string; count: number }>; byPhase: Array<{ phase: string; count: number }>; total: number }
    }
    hideBefore: string | null
    historyResetAt?: string | null
  }> => apiFetch('/api/failures'),

  clearFailures: (): Promise<{ success: boolean }> =>
    apiFetch('/api/failures', { method: 'DELETE' }),

  getScrapedClasses: (): Promise<{ classes: ScrapedClass[]; scrapedAt: string | null }> =>
    apiFetch('/api/scraped-classes'),

  refreshSchedule: (): Promise<{ count: number; scraped_at: string }> =>
    apiFetch('/refresh-schedule', { method: 'POST' }),

  resetBooking: (id: number): Promise<{ success: boolean }> =>
    apiFetch('/reset-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  clearEscalation: (id: number): Promise<{ success: boolean }> =>
    apiFetch('/clear-escalation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  cancelRegistration: (id: number): Promise<{ success: boolean; action: string | null; message: string; staleState?: boolean; stateAutoCorrected?: boolean; recheck?: { found: boolean | null; enrolled: boolean | null; reason: string } }> =>
    apiFetch('/cancel-registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  getSniperState: (): Promise<SniperRunState> =>
    apiFetch('/api/sniper-state'),

  getSessionStatus: (): Promise<SessionStatus> => apiFetch('/api/session-status'),

  checkSession: (): Promise<{
    valid:       boolean | null
    checkedAt:   string | null
    detail:      string | null
    screenshot:  string | null
    label:       string | null          // "Session ready" | "Login required" | etc.
    daxko:       string | null          // 'DAXKO_READY' | 'AUTH_NEEDS_LOGIN' | 'AUTH_UNKNOWN'
    familyworks: string | null          // 'FAMILYWORKS_READY' | 'FAMILYWORKS_SESSION_MISSING' | etc.
  }> => apiFetch('/api/session-check', { method: 'POST' }),

  settingsLogin: (): Promise<{
    success: boolean
    locked?: boolean
    daxko?: SessionStatus['daxko']
    familyworks?: SessionStatus['familyworks']
    lastVerified?: string | null
    detail?: string
    screenshot?: string | null
  }> => apiFetch('/api/settings-login', { method: 'POST' }),

  settingsRefresh: (): Promise<{
    success: boolean
    locked?: boolean
    daxko?: SessionStatus['daxko']
    familyworks?: SessionStatus['familyworks']
    overall?: SessionStatus['overall']
    lastVerified?: string | null
    detail?: string
    tier?: 2 | 3
  }> => apiFetch('/api/settings-refresh', { method: 'POST' }),

  validateSession: (opts?: { forceMinTier?: 1 | 2 | 3 }): Promise<{
    success:     boolean
    valid:       boolean
    daxko:       string | null
    familyworks: string | null
    checkedAt:   string | null
    detail:      string | null
  }> =>
    apiFetch('/api/validate-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }),

  settingsClear: (): Promise<{
    success: boolean
    daxko?: SessionStatus['daxko']
    familyworks?: SessionStatus['familyworks']
    overall?: SessionStatus['overall']
    lastVerified?: string | null
    detail?: string
  }> => apiFetch('/api/settings-clear', { method: 'POST' }),

  getAutoPreflightConfig: (): Promise<{
    enabled: boolean
    lastRun: {
      timestamp:   string
      jobId:       number
      classTitle:  string
      triggerName: string   // '30min' | '10min' | '2min'
      status:      string   // 'pass' | 'fail' | 'error'
      message:     string
    } | null
    nextTrigger: {
      jobId:       number
      triggerName: string
      msUntil:     number   // ms until trigger fires
    } | null
  }> => apiFetch('/api/auto-preflight-config'),

  setAutoPreflightEnabled: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> =>
    apiFetch('/api/auto-preflight-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  getSessionKeepaliveConfig: (): Promise<{
    enabled:         boolean
    intervalMinutes: number
    intervalHours:   number
    lastRun: {
      timestamp:  string
      valid:      boolean
      detail:     string
      screenshot: string | null
    } | null
    next: {
      msUntil:         number
      intervalMinutes: number
      intervalHours:   number
    } | null
  }> => apiFetch('/api/session-keepalive-config'),

  setSessionKeepaliveConfig: (enabled: boolean, intervalMinutes?: number): Promise<{
    success: boolean; enabled: boolean; intervalMinutes: number; intervalHours: number
  }> =>
    apiFetch('/api/session-keepalive-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, intervalMinutes }),
    }),

  runPreflight: (jobId: number): Promise<{
    success:         boolean
    /** Distinguishes lookup-miss responses from real preflight outcomes:
     *  JOB_GONE       — the requested jobId no longer exists in the DB
     *  JOB_INACTIVE   — the row exists but is_active=0
     *  NO_ACTIVE_JOBS — no jobId sent and no active jobs exist
     *  Absent on a real preflight run (success or otherwise). */
    code?:           'JOB_GONE' | 'JOB_INACTIVE' | 'NO_ACTIVE_JOBS'
    /** Server-side context for forensic debugging of vanish-cycles. */
    requestedJobId?: number | null
    currentJobIds?:  number[]
    status:          string
    message:         string
    sniperState:     SniperRunState | null
    authDetail: {
      verdict:  'ready' | 'login_required' | 'session_expired'
      provider: string | null    // 'Daxko' | 'FamilyWorks'
      detail:   string | null
    } | null
    modalDetail: {
      verdict:        'reachable' | 'login_required' | 'blocked'
      detail:         string | null
      screenshot:     string | null       // filename in screenshots/ dir; null on success
      buttonsVisible: string[] | null     // e.g. ["Register", "Cancel"]
      modalPreview:   string | null       // text snippet of modal content
    } | null
    actionDetail: {
      verdict:               'ready' | 'waitlist_only' | 'cancel_only' | 'not_available' | 'login_required' | 'not_open_yet' | 'unknown'
      actionState:           string | null     // raw e.g. 'REGISTER_AVAILABLE', 'WAITLIST_AVAILABLE'
      actionStateClassified: string | null     // Stage 6/7: classifier result: bookable/waitlist_available/full/closed/already_registered/unknown
      buttonsVisible:        string[] | null   // all button labels seen in the modal
      registerStrategy:      string | null     // how the Register button is identified
      waitlistStrategy:      string | null     // how the Waitlist button is identified
      detail:                string | null     // human-readable resolution message
    } | null
    discoveryDetail: {
      found:      boolean
      matched:    string | null
      score:      string | null
      signals:    string | null
      second:     string | null
      nearMisses: string | null
    } | null
  }> =>
    apiFetch('/api/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }),

  getReadiness: (): Promise<{
    lastCheckedAt:   string | null
    jobId:           number | null
    classTitle:      string | null
    session:         'ready' | 'error' | 'unknown'
    schedule:        'ready' | 'error' | 'unknown'
    discovery:       'found' | 'missing' | 'unknown'
    modal:           'reachable' | 'blocked' | 'unknown'
    action:          'ready' | 'not_open' | 'blocked' | 'waitlist' | 'unknown'
    source:          string | null
    confidenceScore:     number | null
    confidenceLabel:     'Ready' | 'Almost ready' | 'Needs attention' | 'At risk' | null
    // Stage 8 — schedule-cache freshness piggybacked on the readiness record
    classTruthFreshness: CacheFreshness | null
    armed: {
      armed:          boolean
      state:          'waiting' | 'almost_ready' | 'armed' | 'booking' | 'needs_attention'
      nextWindow:     string | null
      autoRetry:      boolean
      watchingActive: boolean
    }
    executionTiming: {
      opensAt:       string        // ISO — when the booking window opens
      warmupAt:      string        // ISO — when warmup phase begins (3 min before)
      armedAt:       string        // ISO — when armed phase begins (45 s before)
      phase:         'waiting' | 'warmup' | 'armed' | 'executing' | 'confirming'
      confirmingPhase?: string | null  // Sub-phase copy while phase==='confirming' (Task #60)
      msUntilOpen:   DurationMs    // negative when window is already open
      msUntilWarmup: DurationMs
      msUntilArmed:  DurationMs
    } | null
    learnedTiming: {
      learnedOffsetMs:  number
      adjustedArmedMs:  number
      adjustedWarmupMs: number
      observationCount: number
    } | null
    learnedRunSpeed: {
      medianAuthMs:      number
      medianPageLoadMs:  number
      medianDiscoveryMs: number
      medianTotalMs:     number
      neededLeadTimeMs:  number
      observationCount:  number
    } | null
    lastTimingMetrics: {
      open_to_run_start:          number | null
      auth_phase_ms:              number | null
      run_start_to_page_ready:    number | null
      page_ready_to_class_found:  number | null
      class_found_to_first_click: number | null
      modal_open_ms:              number | null
      first_click_to_confirmation:number | null
      open_to_confirmation:       number | null
      total_first_attempt_ms:     number | null
      slowest_phase:              string | null
      filter_apply_ms:            number | null
      card_click_ms:              number | null
      modal_wait_ms:              number | null
      modal_verify_ms:            number | null
      modal_to_action_ready_ms:   number | null
      degradation: {
        detected:   boolean
        thresholdX: number
        slowPhases: Array<{
          phase:     string
          currentMs: number
          medianMs:  number
          ratioX:    number
        }>
      } | null
    } | null
    escalation: {
      jobId:          number
      classTitle:     string | null
      classTime:      string | null
      reason:         string
      escalatedAt:    string
      executionPhase: string
      attemptNumber:  number
    } | null
  }> => apiFetch('/api/readiness'),

  fetchReplay: (jobId: number | string): Promise<import('./replayEvent').ReplaySummary | null> =>
    apiFetch(`/api/replay/${jobId}`).catch(() => null),

  fetchReplayRun: (jobId: number | string, runId: string): Promise<import('./replayEvent').ReplaySummary | null> =>
    apiFetch(`/api/replay/${jobId}/${encodeURIComponent(runId)}`).catch(() => null),

  fetchReplayHistory: (jobId: number | string): Promise<{ runs: import('./replayEvent').ReplayRunMeta[] }> =>
    apiFetch(`/api/replay-history/${jobId}`).catch(() => ({ runs: [] })),

  classifyJob: (id: number): Promise<ClassTruthResult> =>
    apiFetch(`/api/jobs/${id}/classify`),

  // ── Recovery actions ───────────────────────────────────────────────────────
  clearTransient: (): Promise<{
    success: boolean; cleared: string[]; skipped: string[]; errors: { file: string; error: string }[]; summary: string
  }> =>
    apiFetch('/api/recovery/clear-transient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),

  resyncPg: (): Promise<{ success: boolean; jobCount: number; message: string }> =>
    apiFetch('/api/recovery/resync-pg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }),

  resetJobState: (id: number): Promise<{
    success: boolean; job: { id: number; classTitle: string }; clearedFields: string[]; message: string
  }> =>
    apiFetch('/api/recovery/reset-job-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, confirm: true }),
    }),

  getConfirmedReady: (jobId?: number): Promise<ConfirmedReadyState> =>
    apiFetch(`/api/confirmed-ready${jobId != null ? `?jobId=${jobId}` : ''}`),
}
