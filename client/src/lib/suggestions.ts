// Stage 9.5 — Smart Suggestions Engine
//
// Pure computation — zero API calls.
// Derives a prioritised suggestion list from failure trends, session state,
// sniper state, and confidence score.  Callers decide how many to show and
// which priority tier to surface.

export interface Suggestion {
  id:       string            // stable React key + dedup
  priority: 'high' | 'med'   // high → may appear on Now; med → Tools only
  text:     string            // short actionable sentence (≤ 72 chars)
  detail?:  string            // optional second line shown in Tools
}

// ── Minimal type copies so this file has no circular imports ─────────────────

interface TrendRow  { reason: string; count: number }
interface TrendData { byReason: TrendRow[]; total: number }

export interface SuggestionInputs {
  trends7d?:        TrendData | null
  sessionValid?:    boolean | null   // null = never checked
  sniperState?:     string  | null
  confidenceScore?: number  | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cnt(trends: TrendData | null | undefined, reason: string): number {
  if (!trends) return 0
  return trends.byReason.find(r => r.reason === reason)?.count ?? 0
}

function any(trends: TrendData | null | undefined, ...reasons: string[]): number {
  return reasons.reduce((s, r) => s + cnt(trends, r), 0)
}

// ── Rule engine ───────────────────────────────────────────────────────────────

export function generateSuggestions({
  trends7d,
  sessionValid,
  sniperState,
  confidenceScore,
}: SuggestionInputs): Suggestion[] {
  const suggestions: Suggestion[] = []

  // ── Session / auth ────────────────────────────────────────────────────────
  if (sessionValid === false) {
    suggestions.push({
      id:       'session-invalid',
      priority: 'high',
      text:     'Session check failed — verify your credentials are correct',
    })
  }

  if (sniperState === 'SNIPER_BLOCKED_AUTH') {
    suggestions.push({
      id:       'auth-blocked',
      priority: 'high',
      text:     'Auth blocked — run Preflight Check to restore access',
    })
  }

  if (any(trends7d, 'session_expired', 'session_invalid', 'login_failed') >= 1) {
    if (!suggestions.some(s => s.id === 'session-invalid' || s.id === 'auth-blocked')) {
      suggestions.push({
        id:       'session-failures',
        priority: 'high',
        text:     'Session issues detected — run Preflight closer to registration window',
        detail:   'Auth failures in the last 7 days can cause missed registrations',
      })
    }
  }

  // ── Class / modal identity mismatches ─────────────────────────────────────
  if (cnt(trends7d, 'modal_instructor_mismatch') >= 1) {
    suggestions.push({
      id:       'instructor-mismatch',
      priority: 'med',
      text:     'Instructor mismatch — verify the instructor name in Plan',
      detail:   'The registration modal showed a different instructor than expected',
    })
  }

  if (cnt(trends7d, 'modal_time_mismatch') >= 1) {
    suggestions.push({
      id:       'time-mismatch',
      priority: 'med',
      text:     'Time mismatch — confirm the class time in Plan',
      detail:   'The modal showed a different time than configured',
    })
  }

  // ── Booking availability ──────────────────────────────────────────────────
  if (cnt(trends7d, 'booking_not_open') >= 1) {
    suggestions.push({
      id:       'booking-not-open',
      priority: 'med',
      text:     'Register button not found — class may be waitlist-only',
      detail:   'Or the registration window timing may be slightly off',
    })
  }

  // ── Class discovery ───────────────────────────────────────────────────────
  if (cnt(trends7d, 'class_not_found') >= 1) {
    suggestions.push({
      id:       'class-not-found',
      priority: 'med',
      text:     'Class not found during scan — check class details in Plan',
      detail:   'May be an instructor name or category filter mismatch',
    })
  }

  // ── Infrastructure ────────────────────────────────────────────────────────
  if (cnt(trends7d, 'schedule_not_rendered') >= 2) {
    suggestions.push({
      id:       'schedule-slow',
      priority: 'med',
      text:     'Schedule repeatedly failed to load — Daxko may be slow',
      detail:   'No action needed if it was a one-off; monitor closely near registration',
    })
  }

  // ── Low confidence catch-all ──────────────────────────────────────────────
  if (
    confidenceScore != null &&
    confidenceScore < 60 &&
    !suggestions.some(s => s.priority === 'high')
  ) {
    suggestions.push({
      id:       'low-confidence',
      priority: 'high',
      text:     'Low confidence — run Preflight Check in Tools before window opens',
    })
  }

  return suggestions
}
