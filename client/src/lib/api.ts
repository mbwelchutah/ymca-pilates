import type { Job, AppState, ScrapedClass } from '../types'
import type { ReadinessBundle, SniperState } from './readinessTypes'
import type { ExecutionPhase, SniperEvent } from './failureTypes'

export interface SniperRunState {
  runId:          string | null
  jobId:          number | null
  phase:          ExecutionPhase | null
  bundle:         ReadinessBundle
  sniperState:    SniperState
  authBlockedAt:  string | null   // set by real booking runs; never by skip events
  events:         SniperEvent[]
  updatedAt:      string | null
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

  getSessionStatus: (): Promise<{
    valid: boolean | null
    checkedAt: string | null
    detail: string | null
    screenshot: string | null
  }> => apiFetch('/api/session-status'),

  checkSession: (): Promise<{
    valid: boolean | null
    checkedAt: string | null
    detail: string | null
    screenshot: string | null
  }> => apiFetch('/api/session-check', { method: 'POST' }),

  runPreflight: (jobId: number): Promise<{
    success: boolean
    status: string
    message: string
    sniperState: SniperRunState | null
  }> =>
    apiFetch('/api/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }),
}
