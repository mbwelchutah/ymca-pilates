// Phase-aware retry strategy (Stage 10B)
//
// Classifies bot run outcomes into discrete failure types and computes
// retry timing that adapts to both the failure kind and the execution phase.
//
// Two exports:
//   classifyFailure(botResult)            → failure type string | null (success)
//   computeRetry({ failureType, executionPhase, attemptNumber }) → retry decision
//
// Failure types:
//   auth_failure        — session expired, FamilyWorks auth required
//   class_not_found     — class card absent or time-mismatched on schedule
//   modal_not_reachable — modal blocked, login wall, unreachable
//   action_not_open     — registration window not yet open
//   click_failed        — click sent but outcome unconfirmed / verify failed
//   ambiguous           — unclear result, needs short re-check
//
// Retry behavior per type (all delays adaptive by execution phase):
//   auth_failure        → quick recovery attempt (30 s), then stop (max 2)
//   class_not_found     → burst-shorten near open; regular cadence when distant
//   modal_not_reachable → short backoff regardless of phase
//   action_not_open     → tighten significantly as window approaches
//   click_failed        → flag for Stage 10D fallback; do not retry blindly
//   ambiguous           → very short confirmation loop near open
//
// Log prefix: [retry-strategy]

'use strict';

// ── Failure type constants ────────────────────────────────────────────────────

const FAILURE_TYPES = Object.freeze({
  AUTH_FAILURE:        'auth_failure',
  CLASS_NOT_FOUND:     'class_not_found',
  MODAL_NOT_REACHABLE: 'modal_not_reachable',
  ACTION_NOT_OPEN:     'action_not_open',
  CLICK_FAILED:        'click_failed',
  AMBIGUOUS:           'ambiguous',
});

// ── Failure classifier ────────────────────────────────────────────────────────
//
// Maps from the bot's result object → a failure type string, or null when the
// run was successful (success / registered / waitlisted / waitlist_only).

/**
 * @param {object} botResult  Return value of runBookingJob().
 * @returns {string|null}     One of FAILURE_TYPES, or null on success.
 */
function classifyFailure(botResult) {
  if (!botResult) return FAILURE_TYPES.AMBIGUOUS;

  const { status, reason, phase, category } = botResult;

  // Success variants — not a failure.
  if (
    status === 'booked'       ||
    status === 'success'      ||
    status === 'registered'   ||
    status === 'waitlisted'   ||
    status === 'waitlist_only'
  ) return null;

  // ── Auth failures ──────────────────────────────────────────────────────────
  if (
    category === 'auth'         ||
    phase    === 'auth'         ||
    reason   === 'session_expired'  ||
    reason   === 'auth_required'    ||
    reason   === 'login_required'
  ) return FAILURE_TYPES.AUTH_FAILURE;

  // ── Class not found ────────────────────────────────────────────────────────
  if (
    status === 'not_found'     ||
    category === 'scan'         ||
    reason   === 'class_not_found'
  ) return FAILURE_TYPES.CLASS_NOT_FOUND;

  // ── Modal not reachable ────────────────────────────────────────────────────
  if (
    category === 'modal'        ||
    phase    === 'modal'        ||
    reason   === 'modal_blocked'  ||
    reason   === 'modal_failed'
  ) return FAILURE_TYPES.MODAL_NOT_REACHABLE;

  // ── Action not open yet / session temporarily uncertain ───────────────────
  if (
    status === 'not_open'            ||
    status === 'found_not_open_yet'  ||  // modal reachable, session valid, window not open yet
    status === 'session_uncertain'   ||  // both HTTP pings timed out — network blip, not auth failure
    status === 'full'                ||  // class is full (no waitlist button) — poll for cancellations
    reason === 'not_open'            ||
    reason === 'action_not_open'     ||
    reason === 'class_full'          ||  // same — keep checking at 3-min cadence
    reason === 'ping_timeout'            // network blip — do not escalate to auth failure
  ) return FAILURE_TYPES.ACTION_NOT_OPEN;

  // ── Click / verify failed ──────────────────────────────────────────────────
  if (
    phase    === 'verify'       ||
    category === 'verify'       ||
    reason   === 'verify_failed'  ||
    reason   === 'click_failed'
  ) return FAILURE_TYPES.CLICK_FAILED;

  // ── Catch-all: ambiguous ───────────────────────────────────────────────────
  return FAILURE_TYPES.AMBIGUOUS;
}

// ── Retry delay table (ms) ────────────────────────────────────────────────────
// Indexed by [failureType][executionPhase].
// Phases: waiting | warmup | armed | executing | confirming
// Armed and executing use the shortest delays — time is critical.

const RETRY_DELAY_MS = {
  [FAILURE_TYPES.AUTH_FAILURE]: {
    waiting:    30_000,  // quick recovery
    warmup:     30_000,
    armed:      30_000,
    executing:  30_000,
    confirming: 30_000,
  },
  [FAILURE_TYPES.CLASS_NOT_FOUND]: {
    waiting:   3 * 60_000, // 3 min — window is distant
    warmup:       60_000,  // 1 min — starting to matter
    armed:        30_000,  // 30 s  — approaching fast
    executing:    30_000,
    confirming:   30_000,
  },
  [FAILURE_TYPES.MODAL_NOT_REACHABLE]: {
    waiting:   3 * 60_000,
    warmup:       60_000,
    armed:        30_000,
    executing:    30_000,
    confirming:   30_000,
  },
  [FAILURE_TYPES.ACTION_NOT_OPEN]: {
    waiting:   3 * 60_000, // far away — scheduler will tick at normal cadence
    warmup:       45_000,  // 45 s   — tighten
    armed:        15_000,  // 15 s   — very frequent near open
    executing:    15_000,
    confirming:   15_000,
  },
  [FAILURE_TYPES.CLICK_FAILED]: {
    waiting:   3 * 60_000, // Stage 10D will handle escalation
    warmup:       60_000,
    armed:        60_000,
    executing:    60_000,
    confirming:   60_000,
  },
  [FAILURE_TYPES.AMBIGUOUS]: {
    waiting:      30_000,  // short re-check loop
    warmup:       15_000,
    armed:         5_000,  // 5 s near open — confirm quickly
    executing:     5_000,
    confirming:    5_000,
  },
};

// Max attempts before the retry strategy marks shouldRetry=false.
// The scheduler can still tick again later if the situation improves.
const MAX_ATTEMPTS = {
  [FAILURE_TYPES.AUTH_FAILURE]:        2,  // 1 quick recovery, then stop
  [FAILURE_TYPES.CLASS_NOT_FOUND]:    10,
  [FAILURE_TYPES.MODAL_NOT_REACHABLE]: 5,
  [FAILURE_TYPES.ACTION_NOT_OPEN]:    20,  // many retries — this is normal "not open yet"
  [FAILURE_TYPES.CLICK_FAILED]:        1,  // do not retry blindly; Stage 10D takes over
  [FAILURE_TYPES.AMBIGUOUS]:           5,
};

// Human-readable notes for logging.
const RETRY_NOTES = {
  [FAILURE_TYPES.AUTH_FAILURE]:        'quick recovery attempt, then stop',
  [FAILURE_TYPES.CLASS_NOT_FOUND]:     'retry shortens near open',
  [FAILURE_TYPES.MODAL_NOT_REACHABLE]: 'retry after short backoff',
  [FAILURE_TYPES.ACTION_NOT_OPEN]:     'retry tightens as window approaches',
  [FAILURE_TYPES.CLICK_FAILED]:        'escalate to fallback strategy (Stage 10D)',
  [FAILURE_TYPES.AMBIGUOUS]:           'short confirmation loop',
};

// ── Retry decision ────────────────────────────────────────────────────────────

/**
 * Compute a retry decision for the given failure context.
 *
 * @param {object} opts
 * @param {string} opts.failureType      One of FAILURE_TYPES.
 * @param {string} opts.executionPhase   From computeExecutionTiming().phase.
 * @param {number} [opts.attemptNumber]  How many attempts have already been made (1-indexed).
 * @returns {{
 *   shouldRetry    : boolean,
 *   retryDelayMs   : number,
 *   maxAttempts    : number,
 *   failureType    : string,
 *   executionPhase : string,
 *   attemptNumber  : number,
 *   note           : string,
 * }}
 */
function computeRetry({
  failureType,
  executionPhase = 'waiting',
  attemptNumber  = 1,
} = {}) {
  const delays      = RETRY_DELAY_MS[failureType] ?? RETRY_DELAY_MS[FAILURE_TYPES.AMBIGUOUS];
  const maxAttempts = MAX_ATTEMPTS[failureType]    ?? 5;
  const note        = RETRY_NOTES[failureType]     ?? 'default retry';

  // Resolve delay for the current phase, falling back to 'waiting' if unknown.
  const phaseKey    = Object.prototype.hasOwnProperty.call(delays, executionPhase)
    ? executionPhase
    : 'waiting';
  const retryDelayMs = delays[phaseKey];

  const shouldRetry = attemptNumber < maxAttempts;

  return {
    shouldRetry,
    retryDelayMs,
    maxAttempts,
    failureType,
    executionPhase,
    attemptNumber,
    note,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { classifyFailure, computeRetry, FAILURE_TYPES };
