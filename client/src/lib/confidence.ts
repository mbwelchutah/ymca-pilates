/**
 * Stage 3 — Confidence Score Engine
 *
 * Derives a 0-100 confidence score from all available readiness signals.
 * Mirrors the server-side confidence.js scoring table so client and server
 * agree on what confidence means, while still allowing a client-only fallback
 * when the server hasn't populated confidenceScore yet.
 *
 * Scoring table (matches src/bot/confidence.js):
 *   Field     | ready/found/reachable | error/missing/blocked | not_open | waitlist | unknown
 *   session   |          25           |           0           |    —     |    —     |   20
 *   schedule  |          15           |           0           |    —     |    —     |    0
 *   discovery |          20           |           0           |    —     |    —     |   10
 *   modal     |          15           |           0           |    —     |    —     |    8
 *   action    |          25           |           0           |   20     |   12     |   12
 *
 * Label thresholds (Stage 4):
 *   80–100 → "High confidence"
 *   60–79  → "Likely"
 *   40–59  → "Uncertain"
 *   0–39   → "At risk"
 */

// ── Input shape (matches GET /api/readiness normalized fields) ────────────────

export interface ConfidenceInput {
  session:   'ready' | 'error' | 'unknown'
  schedule:  'ready' | 'error' | 'unknown'
  discovery: 'found' | 'missing' | 'unknown'
  modal:     'reachable' | 'blocked' | 'unknown'
  action:    'ready' | 'not_open' | 'waitlist' | 'blocked' | 'unknown'
}

// ── Per-field score maps ───────────────────────────────────────────────────────

const SESSION_SCORE: Record<string, number> = {
  ready:   25,
  error:    0,
  unknown: 20,
}

const SCHEDULE_SCORE: Record<string, number> = {
  ready:   15,
  error:    0,
  unknown:  0,
}

const DISCOVERY_SCORE: Record<string, number> = {
  found:   20,
  missing:  0,
  unknown: 10,
}

const MODAL_SCORE: Record<string, number> = {
  reachable: 15,
  blocked:    0,
  unknown:    8,
}

const ACTION_SCORE: Record<string, number> = {
  ready:    25,
  not_open: 20,
  waitlist: 12,
  blocked:   0,
  unknown:  12,
}

// ── Stage 4: Label thresholds (80 / 60 / 40) ─────────────────────────────────

export type ConfidenceLabel = 'High confidence' | 'Likely' | 'Uncertain' | 'At risk'

export interface ConfidenceResult {
  score: number          // 0-100, integer
  label: ConfidenceLabel
}

export function scoreToLabel(score: number): ConfidenceLabel {
  if (score >= 80) return 'High confidence'
  if (score >= 60) return 'Likely'
  if (score >= 40) return 'Uncertain'
  return 'At risk'
}

// ── Stage 4: Label hysteresis ─────────────────────────────────────────────────
// Upgrades (better label) are always accepted immediately.
// Downgrades are only accepted once the score crosses a grace-zone lower bound,
// preventing rapid label oscillation from small score fluctuations.
//
// Grace-zone lower bounds (score must fall BELOW to accept the downgrade):
//   High confidence → Likely    requires score < 75 (not just < 80)
//   Likely          → Uncertain requires score < 55 (not just < 60)
//   Uncertain       → At risk   requires score < 35 (not just < 40)

const LABELS: ConfidenceLabel[] = ['High confidence', 'Likely', 'Uncertain', 'At risk']

const DOWNGRADE_FLOOR: Partial<Record<ConfidenceLabel, number>> = {
  'High confidence': 75,
  'Likely':          55,
  'Uncertain':       35,
}

export function scoreToLabelWithHysteresis(
  score: number,
  current: ConfidenceLabel | null,
): ConfidenceLabel {
  const fresh = scoreToLabel(score)
  if (!current) return fresh

  const currentIdx = LABELS.indexOf(current)
  const freshIdx   = LABELS.indexOf(fresh)

  // Upgrade (lower index = better) — always accept immediately
  if (freshIdx < currentIdx) return fresh

  // Same label — no change
  if (freshIdx === currentIdx) return current

  // Downgrade — only accept if score is below the grace-zone floor
  const floor = DOWNGRADE_FLOOR[current]
  if (floor !== undefined && score >= floor) return current  // hold

  return fresh
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute a 0-100 confidence score from the normalized readiness signals.
 * All five dimensions are used: session, schedule, discovery, modal, action.
 * Unknown fields receive partial credit — "not tested" ≠ "broken".
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const raw =
    (SESSION_SCORE[input.session]     ?? SESSION_SCORE.unknown)   +
    (SCHEDULE_SCORE[input.schedule]   ?? SCHEDULE_SCORE.unknown)  +
    (DISCOVERY_SCORE[input.discovery] ?? DISCOVERY_SCORE.unknown) +
    (MODAL_SCORE[input.modal]         ?? MODAL_SCORE.unknown)     +
    (ACTION_SCORE[input.action]       ?? ACTION_SCORE.unknown)

  const score = Math.max(0, Math.min(100, Math.round(raw)))
  return { score, label: scoreToLabel(score) }
}
