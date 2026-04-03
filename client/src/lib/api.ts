import type { Job, AppState } from '../types'

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

  getFailures: (): Promise<{
    recent: Array<{ name: string; mtime: number; reason: string; meta: Record<string, unknown> }>
    summary: Record<string, number>
  }> => apiFetch('/api/failures'),
}
