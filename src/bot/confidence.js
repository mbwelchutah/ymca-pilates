// Confidence score engine (Stage 9C)
//
// Derives a deterministic 0–100 confidence score and matching label from a
// normalized readiness object (Stage 9B shape). Unknown values receive partial
// credit — not tested ≠ broken.
//
// Scoring table (authoritative):
//   Field     | ready/found/reachable | error/missing/blocked | not_open | waitlist | unknown
//   ----------|-----------------------|-----------------------|----------|----------|---------
//   session   |          25           |           0           |    —     |    —     |   12
//   schedule  |          15           |           0           |    —     |    —     |    8
//   discovery |          20           |           0           |    —     |    —     |   10
//   modal     |          15           |           0           |    —     |    —     |    8
//   action    |          25           |           0           |   20     |   12     |   12
//
// Derived sanity check values (from the table above):
//   All unknown                                    → 12+8+10+8+12 = 50  "Needs attention"
//   Session+schedule ready, rest unknown           → 25+15+10+8+12 = 70  "Almost ready"
//   S+Sch+D+M ready, action=not_open              → 25+15+20+15+20 = 95  "Ready"
//   Session error, rest unknown                   → 0+8+10+8+12  = 38  "At risk"
//   All confirmed ready                            → 25+15+20+15+25 = 100 "Ready"
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
