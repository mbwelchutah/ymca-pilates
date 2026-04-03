export type Phase = 'too_early' | 'warmup' | 'sniper' | 'late' | 'unknown'
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
}

export interface AppState {
  schedulerPaused: boolean
  dryRun: boolean
  selectedJobId: number | null
  jobs: Job[]
}
