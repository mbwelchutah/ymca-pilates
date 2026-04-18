// Transient-vs-actionable failure taxonomy.
//
// Many of the "failures" recorded in the structured failure log are actually
// expected, transient outcomes of the booking loop running before the
// registration window opens or during YMCA infrastructure blips:
//
//   - found_not_open_yet      Preflight ran before the window opened.
//   - button_not_visible      Register/Waitlist button not yet rendered.
//   - booking_not_open        Same idea — gate phase saw no register button.
//   - auth_timeout            Daxko page.goto() 30s timeout — infra blip.
//   - schedule_not_loaded     Schedule panel had not rendered after readiness
//                             wait + reload retry. The next tick recovers.
//   - concurrent_auth         Another flow held the auth lock — we just retry.
//   - click_marker_stripped   Lost a marker in a re-render; retry succeeds.
//
// These count toward the structured failure log (so they're available for
// debugging) but they SHOULD NOT contribute to the rollup "X failures / 7d"
// counter or the Healthy/At-risk badge — they would otherwise drown out the
// few actionable failures the user actually needs to see.
//
// Anything not in this set is treated as actionable (modal_*_mismatch,
// click_failed, registration_unclear, class_not_found, login_failed,
// unexpected_error, etc.).

const TRANSIENT_REASONS = new Set([
  'found_not_open_yet',
  'button_not_visible',
  'auth_timeout',
  'schedule_not_loaded',
  'booking_not_open',
  'concurrent_auth',
  'click_marker_stripped',
]);

function isTransient(reason) {
  return TRANSIENT_REASONS.has(String(reason || ''));
}

function isActionable(reason) {
  return !isTransient(reason);
}

// Pure classifier consumed by both server aggregation and the Tools UI badge.
// Inputs:
//   actionableCount: number of non-transient failures in the rollup window
//   lastResult:      job.last_result string (used for the "currently down" cue)
// Returns one of: 'at_risk' | 'issue' | 'not_run' | 'healthy'.
function classifyJobReliability({ actionableCount = 0, lastResult = null, hasEverRun = true } = {}) {
  const isDown = lastResult === 'failed' || lastResult === 'error';
  if (actionableCount >= 3 || isDown) return 'at_risk';
  if (actionableCount >= 1) return 'issue';
  if (!hasEverRun) return 'not_run';
  return 'healthy';
}

module.exports = {
  TRANSIENT_REASONS,
  isTransient,
  isActionable,
  classifyJobReliability,
};
