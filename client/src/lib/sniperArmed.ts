/**
 * Stage 6 — Sniper Armed Model
 *
 * Derives whether the system is truly armed and ready to fire automatically.
 * This is Layer C of the readiness architecture — distinct from Layer B (confidence).
 *
 *   Layer B — Confidence : 0-100 score, gradient trust signal
 *   Layer C — Armed      : discrete execution readiness, binary armed flag
 *
 * State machine (evaluated in priority order, mirrors src/bot/armed-state.js):
 *   1. bookingActive                              → 'booking'
 *   2. session/schedule error | discovery missing | modal blocked
 *                                                 → 'needs_attention'
 *   3. session ready + class found + modal reachable → 'armed'
 *   4. session ready + class found + modal unknown   → 'almost_ready'
 *   5. session ready + discovery unknown             → 'waiting'
 *   6. (catch-all)                                   → 'needs_attention'
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SniperArmedState =
  | 'waiting'
  | 'almost_ready'
  | 'armed'
  | 'booking'
  | 'needs_attention'

export interface ArmedModel {
  armed:           boolean            // true only when state === 'armed'
  state:           SniperArmedState
  nextWindow:      string | null      // ISO — when the booking window opens
  autoCheckActive: boolean            // scheduler is running and not paused
  autoRetry:       boolean            // scheduler will auto-retry this job
}

// ── Input shape ───────────────────────────────────────────────────────────────
// Matches the normalized fields from GET /api/readiness plus extra context
// supplied by the caller (bookingActive, nextWindow, etc.).

export interface ArmedInput {
  session:         'ready' | 'error' | 'unknown'
  schedule:        'ready' | 'error' | 'unknown'
  discovery:       'found' | 'missing' | 'unknown'
  modal:           'reachable' | 'blocked' | 'unknown'
  bookingActive?:  boolean
  nextWindow?:     string | null
  autoCheckActive?: boolean
  autoRetry?:      boolean
}

// ── State machine ─────────────────────────────────────────────────────────────

function deriveState(input: ArmedInput): SniperArmedState {
  if (input.bookingActive) return 'booking'

  const { session, schedule, discovery, modal } = input

  if (
    session   === 'error'   ||
    schedule  === 'error'   ||
    discovery === 'missing' ||
    modal     === 'blocked'
  ) return 'needs_attention'

  if (session === 'ready' && discovery === 'found' && modal === 'reachable') return 'armed'
  if (session === 'ready' && discovery === 'found')                           return 'almost_ready'
  if (session === 'ready')                                                    return 'waiting'

  return 'needs_attention'
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute the sniper armed model from normalized readiness signals.
 * Call with the 5 readiness fields from GET /api/readiness plus optional
 * context (bookingActive, nextWindow, autoCheckActive, autoRetry).
 */
export function computeArmedModel(input: ArmedInput): ArmedModel {
  const state = deriveState(input)
  return {
    armed:           state === 'armed',
    state,
    nextWindow:      input.nextWindow      ?? null,
    autoCheckActive: input.autoCheckActive ?? false,
    autoRetry:       input.autoRetry       ?? false,
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

export const ARMED_STATE_LABEL: Record<SniperArmedState, string> = {
  armed:           'Auto-registration ready',
  almost_ready:    'Waiting',
  waiting:         'Waiting',
  booking:         'Registering',
  needs_attention: 'Needs attention',
}

export type ArmedDotColor = 'green' | 'amber' | 'red' | 'gray'

export function armedStateDotColor(state: SniperArmedState): ArmedDotColor {
  if (state === 'armed'   || state === 'booking')          return 'green'
  if (state === 'almost_ready' || state === 'waiting')     return 'amber'
  if (state === 'needs_attention')                         return 'red'
  return 'gray'
}
