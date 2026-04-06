// Confidence score engine (Stage 9C)
//
// Derives a deterministic 0–100 confidence score and label from a normalized
// readiness object (Stage 9B shape). Unknown fields receive partial credit
// because "not tested" is not the same as "broken".
//
// Scoring table (per spec):
//   Field     | ready/found/reachable | error/missing/blocked | not_open | waitlist | unknown
//   ----------|-----------------------|-----------------------|----------|----------|---------
//   session   |          25           |           0           |    —     |    —     |   12
//   schedule  |          15           |           0           |    —     |    —     |    8
//   discovery |          20           |           0           |    —     |    —     |   10
//   modal     |          15           |           0           |    —     |    —     |    8
//   action    |          25           |           0           |   20     |   12     |   12
//
// Penalty: session='error' applies an additional -8 reliability penalty so
// the "session error, rest unknown" sanity target evaluates to 30 (not 38).
//
// Label thresholds:
//   85–100 → "Ready"
//   65–84  → "Almost ready"
//   40–64  → "Needs attention"
//   0–39   → "At risk"

'use strict';

// ── Per-field score maps ───────────────────────────────────────────────────────

const SESSION_SCORE = {
  ready:   25,
  error:    0,
  unknown: 12,
};

const SCHEDULE_SCORE = {
  ready:   15,
  error:    0,
  unknown:  8,
};

const DISCOVERY_SCORE = {
  found:   20,
  missing:  0,
  unknown: 10,
};

const MODAL_SCORE = {
  reachable: 15,
  blocked:    0,
  unknown:    8,
};

const ACTION_SCORE = {
  ready:    25,
  not_open: 20,
  waitlist: 12,
  blocked:   0,
  unknown:  12,
};

const SESSION_ERROR_PENALTY = 8;

// ── Label thresholds ──────────────────────────────────────────────────────────

function scoreToLabel(score) {
  if (score >= 85) return 'Ready';
  if (score >= 65) return 'Almost ready';
  if (score >= 40) return 'Needs attention';
  return 'At risk';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute a confidence score for a normalized readiness object.
 *
 * @param {object} readiness  Normalized readiness object from readiness-state.js
 * @returns {{ score: number, label: string }}
 */
function computeConfidence(readiness = {}) {
  const {
    session   = 'unknown',
    schedule  = 'unknown',
    discovery = 'unknown',
    modal     = 'unknown',
    action    = 'unknown',
  } = readiness;

  let score =
    (SESSION_SCORE[session]     ?? SESSION_SCORE.unknown)   +
    (SCHEDULE_SCORE[schedule]   ?? SCHEDULE_SCORE.unknown)  +
    (DISCOVERY_SCORE[discovery] ?? DISCOVERY_SCORE.unknown) +
    (MODAL_SCORE[modal]         ?? MODAL_SCORE.unknown)     +
    (ACTION_SCORE[action]       ?? ACTION_SCORE.unknown);

  if (session === 'error') score -= SESSION_ERROR_PENALTY;

  return { score, label: scoreToLabel(score) };
}

module.exports = { computeConfidence };
