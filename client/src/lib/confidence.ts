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
 * Label thresholds:
 *   85–100 → "Ready"
 *   65–84  → "Almost ready"
 *   40–64  → "Needs attention"
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

export interface ConfidenceResult {
  score:  number   // 0-100, integer
  label:  'Ready' | 'Almost ready' | 'Needs attention' | 'At risk'
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

// ── Label thresholds ──────────────────────────────────────────────────────────

function scoreToLabel(score: number): ConfidenceResult['label'] {
  if (score >= 85) return 'Ready'
  if (score >= 65) return 'Almost ready'
  if (score >= 40) return 'Needs attention'
  return 'At risk'
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
