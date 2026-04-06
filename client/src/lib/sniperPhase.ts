/**
 * Sniper Mode Visualizer — Stage 1: Phase Model
 *
 * Six visual phases that map existing system signals to a user-facing
 * representation of the sniper's lifecycle.  NO booking logic lives here —
 * this is purely a display layer that reads from already-computed state.
 *
 * Priority order (highest → lowest):
 *   1. firing     — active booking attempt (bookingActive + sniper window open)
 *   2. confirming — post-click verification running (execPhase)
 *   3. countdown  — warmup window open (≤10 min before booking window)
 *   4. armed      — all signals green, too_early phase (waiting for time)
 *   5. locked     — class + session confirmed, modal not yet verified
 *   6. monitoring — fallback: background checks running, data sparse
 *
 * "needs_attention" in the underlying model is intentionally excluded — the
 * existing result card handles that signal.  Callers should skip the sniper
 * visualizer when the armed state is 'needs_attention'.
 */

// ── Phase type ────────────────────────────────────────────────────────────────

export type SniperPhase =
  | 'monitoring'   // Background checks running, minimal confirmed data
  | 'locked'       // Class found + session ready; modal not yet confirmed
  | 'armed'        // All checks green; waiting for booking window to open
  | 'countdown'    // Within warmup window (≤10 min to open); ticking down
  | 'firing'       // Booking attempt in progress right now
  | 'confirming'   // Post-click: verifying registration succeeded

// ── Input shape ───────────────────────────────────────────────────────────────
// All fields come from already-computed UI state in NowScreen — no new API calls.

export interface SniperPhaseInput {
  /** Armed state from computeArmedModel / bgReadiness.armed.state */
  armedState:    'waiting' | 'almost_ready' | 'armed' | 'booking' | 'needs_attention' | null
  /** Client-side booking window phase */
  clientPhase:   'too_early' | 'warmup' | 'sniper' | 'late' | 'unknown'
  /** Server-authoritative execution phase from executionTiming.phase */
  execPhase:     string | null
  /** True only during a real booking run (jobState.active) */
  bookingActive: boolean
}

// ── Phase mapping ─────────────────────────────────────────────────────────────

export function deriveSniperPhase(input: SniperPhaseInput): SniperPhase {
  const { armedState, clientPhase, execPhase, bookingActive } = input

  // 1. Firing — real booking attempt is running right now
  if (bookingActive || armedState === 'booking') return 'firing'

  // 2. Confirming — post-click verification (server signal is authoritative)
  if (execPhase === 'confirming') return 'confirming'

  // 3. Countdown — warmup window open: 1–10 minutes before booking window
  if (clientPhase === 'warmup') return 'countdown'

  // 4. Armed — all checks green, window not yet open
  if (armedState === 'armed') return 'armed'

  // 5. Locked — class found + session ready, modal not yet confirmed
  if (armedState === 'almost_ready') return 'locked'

  // 6. Monitoring — fallback: scheduler watching, data still accumulating
  return 'monitoring'
}

// ── Phase metadata ────────────────────────────────────────────────────────────

export interface SniperPhaseInfo {
  label:       string   // Short user-facing label
  description: string   // One-line calm description
  dotColor:    'green' | 'amber' | 'gray' | 'blue'
  pulse:       boolean  // Whether the dot should animate
}

export const SNIPER_PHASE_INFO: Record<SniperPhase, SniperPhaseInfo> = {
  monitoring: {
    label:       'Monitoring',
    description: 'System is watching and checking',
    dotColor:    'gray',
    pulse:       false,
  },
  locked: {
    label:       'Locked on class',
    description: 'Class identified and session confirmed',
    dotColor:    'amber',
    pulse:       false,
  },
  armed: {
    label:       'Armed and ready',
    description: 'All checks passed — waiting for window to open',
    dotColor:    'green',
    pulse:       false,
  },
  countdown: {
    label:       'Countdown',
    description: 'Window opening soon — standing by',
    dotColor:    'green',
    pulse:       true,
  },
  firing: {
    label:       'Firing now',
    description: 'Attempting registration',
    dotColor:    'green',
    pulse:       true,
  },
  confirming: {
    label:       'Confirming',
    description: 'Verifying registration',
    dotColor:    'blue',
    pulse:       true,
  },
}
