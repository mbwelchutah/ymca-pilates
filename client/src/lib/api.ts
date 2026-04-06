import type { Job, AppState, ScrapedClass, SessionStatus } from '../types'
import type { ReadinessBundle, SniperState } from './readinessTypes'
import type { ExecutionPhase, SniperEvent } from './failureTypes'

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
  events:                 SniperEvent[]
  updatedAt:              string | null
  lastPreflightSnapshot: {
    checkedAt:       string
    status:          string
    authDetail:      { verdict: string; provider: string | null; detail: string | null } | null
    discoveryDetail: { found: boolean; matched: string | null; score: string | null; signals: string | null; second: string | null; nearMisses: string | null } | null
    modalDetail:     { verdict: string; detail: string | null; screenshot: string | null; buttonsVisible: string[] | null; modalPreview: string | null } | null
    actionDetail:    { verdict: string; actionState: string | null; buttonsVisible: string[] | null; registerStrategy: string | null; waitlistStrategy: string | null; detail: string | null } | null
  } | null
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
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

  forceRunJob: (id: number): Promise<{ success: boolean; message: string }> =>
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
  }> => apiFetch('/api/failures'),

  getScrapedClasses: (): Promise<{ classes: ScrapedClass[] }> =>
    apiFetch('/api/scraped-classes'),

  refreshSchedule: (): Promise<{ count: number; scraped_at: string }> =>
    apiFetch('/refresh-schedule', { method: 'POST' }),

  resetBooking: (id: number): Promise<{ success: boolean }> =>
    apiFetch('/reset-booking', {
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
  }> => apiFetch('/api/settings-refresh', { method: 'POST' }),

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
    enabled:       boolean
    intervalHours: number
    lastRun: {
      timestamp:  string
      valid:      boolean
      detail:     string
      screenshot: string | null
    } | null
    next: {
      msUntil:       number
      intervalHours: number
    } | null
  }> => apiFetch('/api/session-keepalive-config'),

  setSessionKeepaliveConfig: (enabled: boolean, intervalHours?: number): Promise<{
    success: boolean; enabled: boolean; intervalHours: number
  }> =>
    apiFetch('/api/session-keepalive-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, intervalHours }),
    }),

  runPreflight: (jobId: number): Promise<{
    success:         boolean
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
      verdict:          'ready' | 'waitlist_only' | 'login_required' | 'full' | 'unknown'
      actionState:      string | null     // raw e.g. 'REGISTER_AVAILABLE', 'WAITLIST_AVAILABLE'
      buttonsVisible:   string[] | null   // all button labels seen in the modal
      registerStrategy: string | null     // how the Register button is identified
      waitlistStrategy: string | null     // how the Waitlist button is identified
      detail:           string | null     // human-readable resolution message
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
    confidenceScore: number | null
    confidenceLabel: 'Ready' | 'Almost ready' | 'Needs attention' | 'At risk' | null
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
      msUntilOpen:   number        // negative when window is already open
      msUntilWarmup: number
      msUntilArmed:  number
    } | null
    learnedTiming: {
      learnedOffsetMs:  number
      adjustedArmedMs:  number
      adjustedWarmupMs: number
      observationCount: number
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
}
