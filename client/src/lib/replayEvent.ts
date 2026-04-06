/**
 * Sniper Replay — Event Model (Stage 1)
 *
 * Each replay event represents one observable moment during a booking attempt.
 * Events are human-readable: no Playwright internals, no raw error objects.
 *
 * Allowed types map to distinct visual treatments in the timeline UI:
 *
 *   window_open     — booking window became active
 *   target_acquired — class page found and identity verified
 *   modal_opened    — registration modal is visible
 *   action_attempt  — register / waitlist button clicked
 *   retry           — previous attempt failed, retrying
 *   success         — booking confirmed
 *   waitlist        — joined waitlist instead
 *   failure         — booking not completed
 *   confirm         — post-action confirmation detected
 */

export type ReplayEventType =
  | 'window_open'
  | 'target_acquired'
  | 'modal_opened'
  | 'action_attempt'
  | 'retry'
  | 'success'
  | 'waitlist'
  | 'failure'
  | 'confirm'

export interface ReplayEvent {
  timestamp: string   // ISO 8601 — e.g. "2026-04-14T10:20:02.341Z"
  type:      ReplayEventType
  label:     string   // short human phrase — e.g. "Clicked Register"
  detail?:   string   // optional supporting note — e.g. "Attempt 1 of 3"
}

// ── Outcome derived from the event stream ─────────────────────────────────────
// Summarises the final result of a booking attempt across all its events.

export type ReplayOutcome = 'success' | 'waitlist' | 'failure' | 'unknown'

export interface ReplaySummary {
  jobId:      number
  runId:      string          // unique per attempt — e.g. ISO timestamp of window_open
  outcome:    ReplayOutcome
  events:     ReplayEvent[]
  capturedAt: string          // ISO 8601 — when the run finished / was saved
}

/** Lightweight metadata entry in the per-job run index (Stage 6). */
export interface ReplayRunMeta {
  runId:      string
  outcome:    ReplayOutcome
  capturedAt: string          // ISO 8601
  eventCount: number
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** One-word icon hint for each event type — used by the timeline UI. */
export const REPLAY_ICON: Record<ReplayEventType, string> = {
  window_open:     '🕐',
  target_acquired: '🎯',
  modal_opened:    '📋',
  action_attempt:  '👆',
  retry:           '🔄',
  success:         '✅',
  waitlist:        '📝',
  failure:         '❌',
  confirm:         '✓',
}

/** Terminal event types — the run ends at one of these. */
export const REPLAY_TERMINAL_TYPES = new Set<ReplayEventType>([
  'success',
  'waitlist',
  'failure',
])
