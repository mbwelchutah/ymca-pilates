/**
 * Deep preflight wrapper — STAGE 4.
 *
 * Reusable, isolated end-to-end verification:
 *
 *   runDeepPreflightCheck(jobId, options)
 *
 * Reuses the EXISTING preflight code path:
 *
 *   src/bot/register-pilates.js → runBookingJob(job, { preflightOnly: true })
 *
 * `preflightOnly: true` is the established booking-bot mode that walks the
 * full flow — auth → schedule → row → modal — and STOPS before any booking
 * click.  We do NOT alter that mode here; we just wrap it so its outcome
 * lands in the new connection-health record introduced in Stages 2 & 3.
 *
 * What this file does NOT do:
 *   - launch a separate Playwright pipeline (it reuses the canonical one)
 *   - modify booking, sniper, retry, or selector logic
 *   - get wired into the scheduler tick (Stage 6 will do that)
 *   - touch UI surfaces (Stage 7)
 *
 * Concurrency: the underlying runBookingJob() already serialises browser
 * launches via its own auth lock and per-job mutex.  We add a tiny in-process
 * guard so two callers asking for a deep check on the same job at the same
 * instant don't queue two browser sessions; the second simply observes the
 * first one's promise.
 */

'use strict';

const { runBookingJob }                    = require('../bot/register-pilates');
const { getJobById }                       = require('../db/jobs');
const { FAILURE_REASONS, HEALTH_STATES }   = require('./connection-health');
const { updateHealth }                     = require('./connection-health-store');

// In-flight deep checks, keyed by jobId.  Lets concurrent callers share a run.
const _inFlight = new Map();

// ─── Result-mapping helpers (pure) ──────────────────────────────────────────

/**
 * Map runBookingJob() result → "deepest stage successfully verified".
 *
 * Stage ladder (low → high):  null → 'auth' → 'schedule' → 'row' → 'modal'
 *
 * - On success/booked/full/closed/already_registered the entire ladder
 *   was traversed (modal opened, action classified) → 'modal'.
 * - On failure, the result.phase tells us where it broke:
 *
 *     phase 'auth'                  → never proved auth → null
 *     phase 'navigate'              → auth proven       → 'auth'
 *     phase 'scan'                  → schedule proven   → 'schedule'
 *     phase 'click'/'verify'        → row proven        → 'row'
 *     phase 'action'/'gate'/'post_click'/'recovery'
 *                                   → modal proven      → 'modal'
 *     phase 'system' (or unknown)   → cannot tell       → null
 *
 * Pure function.
 */
function deriveVerifiedStage(result) {
  if (!result || typeof result !== 'object') return null;

  const successStatuses = new Set([
    'success', 'booked', 'full', 'closed', 'already_registered',
  ]);
  if (successStatuses.has(result.status)) return 'modal';

  switch (result.phase) {
    case 'auth':                 return null;
    case 'navigate':             return 'auth';
    case 'scan':                 return 'schedule';
    case 'click':
    case 'verify':               return 'row';
    case 'action':
    case 'gate':
    case 'post_click':
    case 'recovery':             return 'modal';
    case 'system':               return null;
    default:                     return null;
  }
}

/**
 * Map runBookingJob() failure → ConnectionHealth FAILURE_REASONS.
 * Pure function.  Returns null on success.
 */
function deriveFailureReason(result) {
  if (!result || typeof result !== 'object') return null;
  const successStatuses = new Set([
    'success', 'booked', 'full', 'closed', 'already_registered',
  ]);
  if (successStatuses.has(result.status)) return null;

  const reason = (result.reason || '').toLowerCase();
  const phase  = (result.phase  || '').toLowerCase();

  // Auth-shaped failures.
  if (phase === 'auth') {
    if (/session_expired|unauthorized|login/.test(reason)) {
      return FAILURE_REASONS.SESSION_EXPIRED;
    }
    return FAILURE_REASONS.AUTH_REDIRECT;
  }

  // Schedule-load failures.
  if (phase === 'navigate'
      || /schedule_not_loaded|schedule_not_rendered|filter_apply_failed/.test(reason)) {
    return FAILURE_REASONS.SCHEDULE_LOAD;
  }

  // Row-discovery failures.
  if (phase === 'scan' || /class_not_found/.test(reason)) {
    return FAILURE_REASONS.ROW_NOT_FOUND;
  }

  // Modal-mismatch failures.
  if (phase === 'click' || phase === 'verify') {
    return FAILURE_REASONS.MODAL_MISMATCH;
  }

  // Transport/system failures.
  if (phase === 'system' || /page_crashed|network|timeout|abort/.test(reason)) {
    return FAILURE_REASONS.NETWORK;
  }

  return FAILURE_REASONS.UNKNOWN;
}

// ─── Persistence: write result into connection-health-store ─────────────────

function _persistResult({ startedAt, success, reason, verifiedStage, msUntilOpen }) {
  return updateHealth(() => {
    const patch = {
      lastDeepCheckAt: startedAt,
    };
    if (success) {
      patch.lastDeepSuccessAt  = startedAt;
      // Leave lastFailureReason in place; classifyHealth ignores it once
      // lastDeepSuccessAt > lastFailureAt, so a fresh success implicitly
      // promotes the state (HEALTHY when fresh, DEGRADED when stale).
    } else {
      patch.lastFailureAt     = startedAt;
      patch.lastFailureReason = reason;
      // Auth-shaped reasons force DISCONNECTED via classifier rule #1; no
      // need to hard-set currentState here.  All other reasons fall through
      // to the AT_RISK rule (deepCheckAt > deepSuccessAt) automatically.
    }
    // Carry the verifiedStage as a sidecar field (not part of the formal
    // ConnectionHealth shape — it's diagnostic context for the UI).
    patch.lastVerifiedStage = verifiedStage;
    return patch;
  }, msUntilOpen);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run one deep preflight check for the given jobId.
 *
 * @param {string|number} jobId
 * @param {Object}        [options]
 * @param {?number}       [options.msUntilOpen]  passed through to state derivation
 * @param {Object}        [options.preflightOptions]  forwarded to runBookingJob
 *
 * @returns {Promise<{
 *   success:        boolean,
 *   failureReason?: string,                 // FAILURE_REASONS value (failure only)
 *   verifiedStage:  ?('auth'|'schedule'|'row'|'modal'),
 *   detail:         string,                 // human-readable message from preflight
 *   raw:            object,                 // full runBookingJob() result
 *   health:         object                  // post-write ConnectionHealth record
 * }>}
 *
 * Never throws.  On unexpected error, returns success=false with
 * failureReason='unknown' and a synthetic raw payload.
 */
async function runDeepPreflightCheck(jobId, options = {}) {
  if (jobId == null) {
    throw new Error('runDeepPreflightCheck: jobId is required');
  }
  // De-dup concurrent callers for the same job.
  if (_inFlight.has(jobId)) return _inFlight.get(jobId);

  const promise = (async () => {
    const startedAt   = Date.now();
    const msUntilOpen = options.msUntilOpen ?? null;

    let job;
    try {
      job = getJobById(jobId);
    } catch (err) {
      const health = _persistResult({
        startedAt,
        success:       false,
        reason:        FAILURE_REASONS.UNKNOWN,
        verifiedStage: null,
        msUntilOpen,
      });
      return {
        success:       false,
        failureReason: FAILURE_REASONS.UNKNOWN,
        verifiedStage: null,
        detail:        `getJobById threw: ${err && err.message ? err.message : String(err)}`,
        raw:           { status: 'error', phase: 'system', reason: 'job_lookup_failed' },
        health,
      };
    }
    if (!job) {
      const health = _persistResult({
        startedAt,
        success:       false,
        reason:        FAILURE_REASONS.UNKNOWN,
        verifiedStage: null,
        msUntilOpen,
      });
      return {
        success:       false,
        failureReason: FAILURE_REASONS.UNKNOWN,
        verifiedStage: null,
        detail:        `Job ${jobId} not found`,
        raw:           { status: 'error', phase: 'system', reason: 'job_not_found' },
        health,
      };
    }

    let raw;
    try {
      // Reuse the canonical preflight path.  preflightOnly:true STOPS the
      // bot before any real booking click — this is the existing contract
      // honoured by runBookingJob and we are NOT changing it.
      raw = await runBookingJob(job, {
        ...(options.preflightOptions || {}),
        preflightOnly: true,
      });
    } catch (err) {
      raw = {
        status:  'error',
        phase:   'system',
        reason:  'unexpected_error',
        message: err && err.message ? err.message : String(err),
      };
    }

    const successStatuses = new Set([
      'success', 'booked', 'full', 'closed', 'already_registered',
    ]);
    const success       = successStatuses.has(raw && raw.status);
    const verifiedStage = deriveVerifiedStage(raw);
    const failureReason = success ? null : deriveFailureReason(raw);

    const health = _persistResult({
      startedAt,
      success,
      reason:        failureReason,
      verifiedStage,
      msUntilOpen,
    });

    return {
      success,
      ...(success ? {} : { failureReason }),
      verifiedStage,
      detail: (raw && (raw.message || raw.label)) || (success ? 'preflight ok' : 'preflight failed'),
      raw,
      health,
    };
  })();

  _inFlight.set(jobId, promise);
  try { return await promise; }
  finally { _inFlight.delete(jobId); }
}

module.exports = {
  runDeepPreflightCheck,
  // Exported for unit tests of the pure mapping layer:
  deriveVerifiedStage,
  deriveFailureReason,
};
