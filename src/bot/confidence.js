// Confidence score engine (Stage 9C)
//
// Derives a deterministic 0–100 confidence score and matching label from a
// normalized readiness object (Stage 9B shape). Unknown values receive partial
// credit — not tested ≠ broken.
//
// Scoring table:
//   Field     | ready/found/reachable | error/missing/blocked | not_open | waitlist | unknown
//   ----------|-----------------------|-----------------------|----------|----------|---------
//   session   |          25           |           0           |    —     |    —     |   20
//   schedule  |          15           |           0           |    —     |    —     |    0
//   discovery |          20           |           0           |    —     |    —     |   10
//   modal     |          15           |           0           |    —     |    —     |    8
//   action    |          25           |           0           |   20     |   12     |   12
//
// Note: session.unknown=20 and schedule.unknown=0 are the values that satisfy
// all five required sanity checks simultaneously (the session check dominates:
// session-error shifts score by 20 vs all-unknown baseline, so session-unknown
// must carry 20 pts; schedule-unknown absorbs the remaining allocation of 0).
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
  unknown: 20, // must be 20 to satisfy all five spec sanity checks
};

const SCHEDULE_SCORE = {
  ready:   15,
  error:    0,
  unknown:  0, // must be 0 to satisfy all five spec sanity checks
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
  ready:       25,
  not_open:    20,
  waitlist:    12,
  blocked:      0,
  unknown:     12,
};

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

  const score =
    (SESSION_SCORE[session]     ?? SESSION_SCORE.unknown)   +
    (SCHEDULE_SCORE[schedule]   ?? SCHEDULE_SCORE.unknown)  +
    (DISCOVERY_SCORE[discovery] ?? DISCOVERY_SCORE.unknown) +
    (MODAL_SCORE[modal]         ?? MODAL_SCORE.unknown)     +
    (ACTION_SCORE[action]       ?? ACTION_SCORE.unknown);

  return { score, label: scoreToLabel(score) };
}

module.exports = { computeConfidence };
