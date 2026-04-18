/**
 * Cheap session check — STAGE 3.
 *
 * Lightweight, browser-free verification that the YMCA session is alive.
 * Reuses the existing Tier-2 HTTP ping (src/bot/session-ping.js) — does NOT
 * launch Playwright, does NOT modify the login flow.
 *
 * Side effects:
 *   - Writes lastCheapCheckAt on every run.
 *   - On a CLEARLY DISCONNECTED outcome (auth redirect / 401), also writes
 *     lastFailureAt + lastFailureReason and forces currentState='disconnected'.
 *   - On any other failure (network/unknown) writes the failure fields but
 *     leaves currentState alone — per the "only flip state when clearly
 *     disconnected" rule.
 *   - On success writes only lastCheapCheckAt (does not promote the state).
 *
 * Does NOT:
 *   - trigger retries
 *   - trigger deep checks
 *   - modify booking behaviour
 *   - get wired into the scheduler (Stage 6 will do that)
 *
 * Pure cadence helper `getCheapCheckInterval()` is also exported here so
 * Stage 5's policy module can compose it without re-implementing.
 */

'use strict';

const { pingSessionHttp }                     = require('../bot/session-ping');
const { FAILURE_REASONS, HEALTH_STATES }      = require('./connection-health');
const { updateHealth }                        = require('./connection-health-store');

// ─── Cadence (pure) ─────────────────────────────────────────────────────────

const TWELVE_H = 12 * 60 * 60 * 1000;
const TWO_H    =  2 * 60 * 60 * 1000;

const CHEAP_INTERVAL_MS = Object.freeze({
  FAR:  15 * 60 * 1000, // > 12 h to open
  MID:  10 * 60 * 1000, // 12 h – 2 h
  NEAR:  5 * 60 * 1000, // < 2 h
});

/**
 * Return the recommended interval (ms) between cheap checks for a given
 * proximity to open.  Pure — no timers, no scheduler wiring.
 *
 * @param {?number} msUntilOpen  ms until registration opens, or null if
 *                               there is no upcoming job.
 * @returns {number}
 */
function getCheapCheckInterval(msUntilOpen) {
  if (msUntilOpen == null || !Number.isFinite(msUntilOpen)) return CHEAP_INTERVAL_MS.FAR;
  if (msUntilOpen > TWELVE_H) return CHEAP_INTERVAL_MS.FAR;
  if (msUntilOpen > TWO_H)    return CHEAP_INTERVAL_MS.MID;
  return CHEAP_INTERVAL_MS.NEAR;
}

// ─── Failure-reason classification ──────────────────────────────────────────
//
// Deliberately narrow.  Only AUTH_REDIRECT / SESSION_EXPIRED count as
// "clearly disconnected"; everything else is treated as inconclusive.
function classifyPingFailure(pingResult) {
  const blob = [
    pingResult?.detail || '',
    pingResult?.daxkoResult?.detail || '',
    pingResult?.fwResult?.detail || '',
  ].join(' ').toLowerCase();

  if (/\b401\b|unauthorized|session expired|expired session/.test(blob)) {
    return FAILURE_REASONS.SESSION_EXPIRED;
  }
  if (/redirect.*login|find_account|login page|login redirect/.test(blob)) {
    return FAILURE_REASONS.AUTH_REDIRECT;
  }
  if (/timeout|abort|econn|enotfound|fetch failed|network/.test(blob)) {
    return FAILURE_REASONS.NETWORK;
  }
  return FAILURE_REASONS.UNKNOWN;
}

function isClearlyDisconnected(reason) {
  return reason === FAILURE_REASONS.AUTH_REDIRECT
      || reason === FAILURE_REASONS.SESSION_EXPIRED;
}

// ─── Public: run a single cheap check ───────────────────────────────────────

/**
 * Execute one cheap session check.  Safe to call at any time; never throws.
 *
 * @param {Object}   [opts]
 * @param {?number}  [opts.msUntilOpen]  passed through to state derivation
 * @returns {Promise<{ ok: boolean,
 *                     reason: ?string,
 *                     detail: string,
 *                     health: object }>}
 */
async function runCheapCheck({ msUntilOpen = null } = {}) {
  const startedAt = Date.now();
  let pingResult;

  try {
    pingResult = await pingSessionHttp();
  } catch (err) {
    // Transport-level failure — treat as inconclusive NETWORK.
    const detail = `cheap check threw: ${err && err.message ? err.message : String(err)}`;
    const health = updateHealth(() => ({
      lastCheapCheckAt:  startedAt,
      lastFailureAt:     startedAt,
      lastFailureReason: FAILURE_REASONS.NETWORK,
    }), msUntilOpen);
    return { ok: false, reason: FAILURE_REASONS.NETWORK, detail, health };
  }

  // Success path: only stamp the cheap-check timestamp.  Do NOT promote
  // currentState here — only deep checks can move us into HEALTHY.
  if (pingResult && pingResult.trusted) {
    const health = updateHealth(() => ({
      lastCheapCheckAt: startedAt,
    }), msUntilOpen);
    return {
      ok:     true,
      reason: null,
      detail: pingResult.detail || 'cheap check trusted',
      health,
    };
  }

  // Failure path.
  const reason = classifyPingFailure(pingResult);
  const detail = pingResult?.detail || 'cheap check untrusted';

  const health = updateHealth(() => {
    const patch = {
      lastCheapCheckAt:  startedAt,
      lastFailureAt:     startedAt,
      lastFailureReason: reason,
    };
    // ONLY flip state when clearly disconnected.  Inconclusive failures
    // (NETWORK / UNKNOWN) leave the derived state in place.
    if (isClearlyDisconnected(reason)) {
      patch.currentState = HEALTH_STATES.DISCONNECTED;
    }
    return patch;
  }, msUntilOpen);

  return { ok: false, reason, detail, health };
}

module.exports = {
  CHEAP_INTERVAL_MS,
  getCheapCheckInterval,
  classifyPingFailure,         // exported for tests
  isClearlyDisconnected,       // exported for tests
  runCheapCheck,
};
