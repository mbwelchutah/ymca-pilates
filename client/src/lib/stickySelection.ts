// Task #68 — pure decision helper for the App.tsx sticky-on-transient-miss
// state machine.  Extracted so the algorithm can be exercised by vitest
// without spinning up React + jsdom.
//
// Inputs describe a single observation moment: the current jobs list, the
// currently selected jobId, the last-known job snapshot, when the selection
// first went missing, and the current wall-clock time.
//
// The output tells the caller exactly what to do:
//   action='ok'        — selection is healthy, clear any miss tracking.
//   action='resync'    — selection is missing, but we're inside the grace
//                        window; keep selectedJobId pinned and show the
//                        "Resyncing…" banner.  Caller should also schedule a
//                        re-check at `expiresAtMs` so the banner flushes
//                        even without a poll landing.
//   action='fallback'  — grace expired (or no last-known snapshot); caller
//                        should swap selectedJobId to `nextSelectedId` and
//                        clear the resync flag.
//
// Pure: no Date.now(), no React, no DOM.  All time values come from the
// caller so tests can simulate arbitrary clocks.

export interface StickySelectionInput<J extends { id: number; is_active?: number | boolean }> {
  jobs:               readonly J[]
  selectedJobId:      number | null
  lastKnownJob:       J | null
  missingSinceMs:     number | null
  nowMs:              number
  graceWindowMs:      number
}

export type StickySelectionOutput<J> =
  | { action: 'ok' }
  | { action: 'resync'; missingSinceMs: number; expiresAtMs: number }
  | { action: 'fallback'; nextSelectedId: number | null }

export function decideStickySelection<J extends { id: number; is_active?: number | boolean }>(
  input: StickySelectionInput<J>
): StickySelectionOutput<J> {
  const { jobs, selectedJobId, lastKnownJob, missingSinceMs, nowMs, graceWindowMs } = input

  // Healthy selection — caller should clear any pending miss state.
  if (selectedJobId !== null && jobs.some(j => j.id === selectedJobId)) {
    return { action: 'ok' }
  }

  // Selection is missing.  Engage the grace window only if we have a
  // last-known snapshot for THIS exact selection — otherwise there is
  // nothing meaningful to keep on screen.
  if (selectedJobId !== null && lastKnownJob && lastKnownJob.id === selectedJobId) {
    const startedAt = missingSinceMs ?? nowMs
    const elapsed   = nowMs - startedAt
    if (elapsed < graceWindowMs) {
      return {
        action: 'resync',
        missingSinceMs: startedAt,
        expiresAtMs:    startedAt + graceWindowMs,
      }
    }
  }

  // Grace expired (or no snapshot) — pick a fallback from whatever is
  // currently in the jobs list.  May be null when the list is empty.
  const fallback = jobs.find(j => !!j.is_active) ?? jobs[0] ?? null
  return { action: 'fallback', nextSelectedId: fallback?.id ?? null }
}
