// Phase-aware retry strategy (Stage 10B + Stage 4)
//
// Classifies bot run outcomes into discrete failure types and computes
// retry timing that adapts to both the failure kind and the execution phase.
//
// Two primary exports:
//   classifyFailure(botResult)                                → failure type string | null (success)
//   computeRetry({ failureType, executionPhase, attemptNumber }) → retry decision
//
// Additional exports (Stage 4):
//   isTransientFailure(failureType)  → boolean
//   FAILURE_TYPES                    → frozen constants object
//
// ── Failure type taxonomy (Stage 4) ──────────────────────────────────────────
//
// TRANSIENT — retry fast; the window is still usable:
//   navigation_timeout  — page.goto or page load timed out (site slow at open)
//   click_timeout       — locator.click timed out (DOM re-rendered under the click)
//   button_not_visible  — modal open but action buttons not rendered yet
//   server_slow         — TCP/connection-level failure (net:: errors, refused)
//   modal_not_reachable — modal blocked or click path failed (may be transient)
//   action_not_open     — registration window not yet open; keep polling
//   ambiguous           — unclear result; short re-check loop
//
// HARD STOP — do not retry blindly; requires different action or escalation:
//   auth_failure        — session expired or credentials rejected
//   class_not_found     — class card absent from schedule (may appear later)
//   click_failed        — click sent but outcome unconfirmed (escalate)
//
// ── Retry behavior summary ────────────────────────────────────────────────────
//   auth_failure        → quick recovery attempt (30 s), then stop (max 2)
//   class_not_found     → burst-shorten near open; regular cadence when distant
//   modal_not_reachable → short backoff regardless of phase
//   action_not_open     → tighten significantly as window approaches
//   click_failed        → escalate; do not retry blindly
//   ambiguous           → very short confirmation loop near open
//   navigation_timeout  → retry immediately (10 s); probably transient site load spike
//   click_timeout       → retry quickly (10 s); DOM was likely still rendering
//   button_not_visible  → retry immediately (10 s); action buttons still loading
//   server_slow         → short backoff (20 s); network hiccup
//
// Log prefix: [retry-strategy]

'use strict';

// ── Failure type constants ────────────────────────────────────────────────────

const FAILURE_TYPES = Object.freeze({
  // ── Original types (Stage 10B) ──────────────────────────────────────────────
  AUTH_FAILURE:        'auth_failure',
  CLASS_NOT_FOUND:     'class_not_found',
  MODAL_NOT_REACHABLE: 'modal_not_reachable',
  ACTION_NOT_OPEN:     'action_not_open',
  CLICK_FAILED:        'click_failed',
  AMBIGUOUS:           'ambiguous',
  // ── Transient window-open types (Stage 4) ───────────────────────────────────
  NAVIGATION_TIMEOUT:  'navigation_timeout',  // page load / goto timed out
  CLICK_TIMEOUT:       'click_timeout',        // locator.click timed out
  BUTTON_NOT_VISIBLE:  'button_not_visible',   // modal open, no action buttons yet
  SERVER_SLOW:         'server_slow',           // TCP / connection error
  PAGE_CRASHED:        'page_crashed',          // Playwright renderer crash (transient)
});

// ── Transient classification (Stage 4) ───────────────────────────────────────
//
// Transient failures are recoverable within the current booking window.
// Non-transient (hard-stop) failures require a different action or escalation
// and should NOT be retried at the aggressive early-window cadence.

const TRANSIENT_FAILURE_TYPES = new Set([
  FAILURE_TYPES.NAVIGATION_TIMEOUT,
  FAILURE_TYPES.CLICK_TIMEOUT,
  FAILURE_TYPES.BUTTON_NOT_VISIBLE,
  FAILURE_TYPES.SERVER_SLOW,
  FAILURE_TYPES.PAGE_CRASHED,         // renderer crash — fresh launch usually succeeds
  FAILURE_TYPES.MODAL_NOT_REACHABLE,  // may recover on next attempt
  FAILURE_TYPES.ACTION_NOT_OPEN,      // normal pre-open polling
  FAILURE_TYPES.AMBIGUOUS,            // short re-check
]);

/**
 * Returns true when the failure type is transient and safe to retry fast.
 * Returns false for hard-stop failures that warrant escalation or backing off.
 *
 * @param {string} failureType  One of FAILURE_TYPES.
 * @returns {boolean}
 */
function isTransientFailure(failureType) {
  return TRANSIENT_FAILURE_TYPES.has(failureType);
}

// ── Failure classifier ────────────────────────────────────────────────────────
//
// Maps from the bot's result object → a failure type string, or null when the
// run was successful (success / registered / waitlisted / waitlist_only).
//
// Stage 4: message-content inspection is used as a fallback for Playwright
// errors that arrive via the outer catch in register-pilates.js with a generic
// reason of 'unexpected_error'.  The Playwright error message is stable enough
// to parse reliably.

// Patterns that identify Playwright timeout errors by category.
const _TIMEOUT_MSG_RE        = /timeout|timed out/i;
const _NAVIGATION_MSG_RE     = /page\.goto|page\.navigate|navigation|waitForNavigation/i;
const _LOCATOR_CLICK_MSG_RE  = /locator\.\w*click|locator\.click/i;
const _SERVER_ERROR_MSG_RE   = /net::|ERR_CONNECTION|ECONNREFUSED|ECONNRESET|ENOTFOUND|ERR_NAME_NOT_RESOLVED/i;

/**
 * @param {object} botResult  Return value of runBookingJob().
 * @returns {string|null}     One of FAILURE_TYPES, or null on success.
 */
function classifyFailure(botResult) {
  if (!botResult) return FAILURE_TYPES.AMBIGUOUS;

  const { status, reason, phase, category, message } = botResult;

  // ── Success variants — not a failure ─────────────────────────────────────────
  if (
    status === 'booked'       ||
    status === 'success'      ||
    status === 'registered'   ||
    status === 'waitlisted'   ||
    status === 'waitlist_only'
  ) return null;

  // ── Auth failures ─────────────────────────────────────────────────────────────
  if (
    category === 'auth'              ||
    phase    === 'auth'              ||
    reason   === 'session_expired'   ||
    reason   === 'auth_required'     ||
    reason   === 'login_required'
  ) return FAILURE_TYPES.AUTH_FAILURE;

  // ── Server / connection errors (Stage 4) ──────────────────────────────────────
  // Check before generic timeout so TCP errors resolve to SERVER_SLOW, not
  // NAVIGATION_TIMEOUT (even though they may also contain "timed out").
  if (message && _SERVER_ERROR_MSG_RE.test(message)) {
    return FAILURE_TYPES.SERVER_SLOW;
  }

  // ── Playwright renderer crash ─────────────────────────────────────────────────
  // "page.goto: Page crashed" / "Page crashed" — the Chrome renderer process was
  // killed by the OS (OOM, segfault, etc.).  A fresh browser launch will succeed.
  if (
    reason  === 'page_crashed'            ||
    (message && /Page crashed/i.test(message))
  ) return FAILURE_TYPES.PAGE_CRASHED;

  // ── Navigation timeout (Stage 4) ─────────────────────────────────────────────
  // phase 'navigate' with schedule_not_rendered means the page loaded but was
  // empty — treat as a navigation-level transient failure.
  if (
    reason  === 'navigation_timeout'     ||
    phase   === 'navigate'               ||
    (message && _TIMEOUT_MSG_RE.test(message) && _NAVIGATION_MSG_RE.test(message)) ||
    (message && _TIMEOUT_MSG_RE.test(message) && phase === 'navigate')
  ) return FAILURE_TYPES.NAVIGATION_TIMEOUT;

  // ── Click timeout (Stage 4) ───────────────────────────────────────────────────
  // A locator.click() timeout means the element was present in findTargetCard()
  // but detached / not actionable by the time the click fired.  Retry fast.
  if (
    reason  === 'click_timeout'                                          ||
    (phase  === 'click' && message && _TIMEOUT_MSG_RE.test(message))    ||
    (message && _LOCATOR_CLICK_MSG_RE.test(message) && _TIMEOUT_MSG_RE.test(message))
  ) return FAILURE_TYPES.CLICK_TIMEOUT;

  // ── Button not visible in open modal (Stage 4) ───────────────────────────────
  // The modal was opened and verified, but no Register/Waitlist/Cancel button
  // appeared.  This is a transient race: the window is open but buttons are
  // still loading.  Retry quickly — do NOT wait a full cooldown.
  if (reason === 'button_not_visible') {
    return FAILURE_TYPES.BUTTON_NOT_VISIBLE;
  }

  // ── Class not found ───────────────────────────────────────────────────────────
  if (
    status   === 'not_found'       ||
    category === 'scan'            ||
    reason   === 'class_not_found'
  ) return FAILURE_TYPES.CLASS_NOT_FOUND;

  // ── Modal not reachable ───────────────────────────────────────────────────────
  if (
    category === 'modal'          ||
    phase    === 'modal'          ||
    reason   === 'modal_blocked'  ||
    reason   === 'modal_failed'
  ) return FAILURE_TYPES.MODAL_NOT_REACHABLE;

  // ── Action not open yet / session temporarily uncertain ──────────────────────
  if (
    status === 'not_open'            ||
    status === 'found_not_open_yet'  ||  // modal reachable, window not open yet
    status === 'session_uncertain'   ||  // both HTTP pings timed out — network blip
    status === 'full'                ||  // class full — poll for cancellations
    reason === 'not_open'            ||
    reason === 'action_not_open'     ||
    reason === 'class_full'          ||  // keep checking at 3-min cadence
    reason === 'ping_timeout'            // network blip — not an auth failure
  ) return FAILURE_TYPES.ACTION_NOT_OPEN;

  // ── Click / verify failed ─────────────────────────────────────────────────────
  if (
    phase    === 'verify'         ||
    category === 'verify'         ||
    reason   === 'verify_failed'  ||
    reason   === 'click_failed'
  ) return FAILURE_TYPES.CLICK_FAILED;

  // ── Catch-all: ambiguous ──────────────────────────────────────────────────────
  return FAILURE_TYPES.AMBIGUOUS;
}

// ── Retry delay table (ms) ────────────────────────────────────────────────────
// Indexed by [failureType][executionPhase].
// Phases: waiting | warmup | armed | executing | confirming
// Armed and executing use the shortest delays — time is critical.
//
// Stage 4 additions: navigation_timeout, click_timeout, button_not_visible,
// and server_slow all use very short delays during armed/executing because
// losing even 30 s to a transient blip at window open is unacceptable.

const RETRY_DELAY_MS = {
  [FAILURE_TYPES.AUTH_FAILURE]: {
    waiting:    30_000,
    warmup:     30_000,
    armed:      30_000,
    executing:  30_000,
    confirming: 30_000,
  },
  [FAILURE_TYPES.CLASS_NOT_FOUND]: {
    waiting:   3 * 60_000,
    warmup:       60_000,
    armed:        30_000,
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
    waiting:   3 * 60_000,
    warmup:       45_000,
    armed:        15_000,
    executing:    15_000,
    confirming:   15_000,
  },
  [FAILURE_TYPES.CLICK_FAILED]: {
    waiting:   3 * 60_000,
    warmup:       60_000,
    armed:        60_000,
    executing:    60_000,
    confirming:   60_000,
  },
  [FAILURE_TYPES.AMBIGUOUS]: {
    waiting:      30_000,
    warmup:       15_000,
    armed:         5_000,
    executing:     5_000,
    confirming:    5_000,
  },
  // ── Stage 4: transient window-open types ─────────────────────────────────────
  // Short delays during all phases — these are site-load races, not logic errors.
  // Before the window (waiting/warmup): no need to hammer, use moderate cadence.
  // At the window (armed/executing): retry very fast — seconds matter.
  [FAILURE_TYPES.NAVIGATION_TIMEOUT]: {
    waiting:      60_000,  // 1 min — site may be generally slow
    warmup:       20_000,  // 20 s  — approaching fast
    armed:        10_000,  // 10 s  — right before open; try again immediately
    executing:    10_000,
    confirming:   10_000,
  },
  [FAILURE_TYPES.CLICK_TIMEOUT]: {
    waiting:      60_000,
    warmup:       20_000,
    armed:        10_000,  // 10 s  — DOM re-render race; retry fast
    executing:    10_000,
    confirming:   10_000,
  },
  [FAILURE_TYPES.BUTTON_NOT_VISIBLE]: {
    waiting:      45_000,
    warmup:       15_000,
    armed:        10_000,  // 10 s  — buttons may appear any second
    executing:    10_000,
    confirming:   10_000,
  },
  [FAILURE_TYPES.SERVER_SLOW]: {
    waiting:      60_000,
    warmup:       30_000,
    armed:        20_000,  // 20 s  — give the server a breath, then try again
    executing:    20_000,
    confirming:   20_000,
  },
  [FAILURE_TYPES.PAGE_CRASHED]: {
    waiting:      60_000,
    warmup:       30_000,
    armed:        20_000,  // 20 s  — give the OS a moment before fresh browser launch
    executing:    20_000,
    confirming:   20_000,
  },
};

// Max attempts before the retry strategy marks shouldRetry=false.
const MAX_ATTEMPTS = {
  [FAILURE_TYPES.AUTH_FAILURE]:        2,   // 1 quick recovery, then stop
  [FAILURE_TYPES.CLASS_NOT_FOUND]:    10,
  [FAILURE_TYPES.MODAL_NOT_REACHABLE]: 5,
  [FAILURE_TYPES.ACTION_NOT_OPEN]:    20,   // normal pre-open polling
  [FAILURE_TYPES.CLICK_FAILED]:        1,   // escalate immediately
  [FAILURE_TYPES.AMBIGUOUS]:           5,
  // Stage 4 transient types: allow many retries — these are brief site races
  [FAILURE_TYPES.NAVIGATION_TIMEOUT]:  8,
  [FAILURE_TYPES.CLICK_TIMEOUT]:       8,
  [FAILURE_TYPES.BUTTON_NOT_VISIBLE]: 12,
  [FAILURE_TYPES.SERVER_SLOW]:         6,
  [FAILURE_TYPES.PAGE_CRASHED]:        4,  // rare; stop after 4 — persistent crash = different problem
};

// Human-readable notes for logging.
const RETRY_NOTES = {
  [FAILURE_TYPES.AUTH_FAILURE]:        'quick recovery attempt, then stop',
  [FAILURE_TYPES.CLASS_NOT_FOUND]:     'retry shortens near open',
  [FAILURE_TYPES.MODAL_NOT_REACHABLE]: 'retry after short backoff',
  [FAILURE_TYPES.ACTION_NOT_OPEN]:     'retry tightens as window approaches',
  [FAILURE_TYPES.CLICK_FAILED]:        'escalate to fallback strategy',
  [FAILURE_TYPES.AMBIGUOUS]:           'short confirmation loop',
  [FAILURE_TYPES.NAVIGATION_TIMEOUT]:  'transient site-load spike — retry in 10 s near open',
  [FAILURE_TYPES.CLICK_TIMEOUT]:       'transient DOM race — retry in 10 s near open',
  [FAILURE_TYPES.BUTTON_NOT_VISIBLE]:  'transient button load race — retry in 10 s near open',
  [FAILURE_TYPES.SERVER_SLOW]:         'transient server slowness — retry in 20 s near open',
  [FAILURE_TYPES.PAGE_CRASHED]:        'Playwright renderer crash — fresh browser launch in 20 s',
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
 *   isTransient    : boolean,
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

  const phaseKey     = Object.prototype.hasOwnProperty.call(delays, executionPhase)
    ? executionPhase
    : 'waiting';
  const retryDelayMs = delays[phaseKey];

  const shouldRetry  = attemptNumber < maxAttempts;

  return {
    shouldRetry,
    retryDelayMs,
    maxAttempts,
    failureType,
    executionPhase,
    attemptNumber,
    isTransient: isTransientFailure(failureType),
    note,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { classifyFailure, computeRetry, isTransientFailure, FAILURE_TYPES };
