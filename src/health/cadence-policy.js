/**
 * Cadence policy — STAGE 5.
 *
 * Pure functions only.  No timers, no scheduler imports, no I/O, no
 * Playwright.  Decides WHETHER a cheap or deep check is due, given the
 * persisted ConnectionHealth record and the time until registration opens.
 *
 * Stage 6 will wire these into src/scheduler/tick.js as background work.
 *
 * Inputs:
 *   - now           : epoch ms (defaults to Date.now())
 *   - health        : ConnectionHealth record from connection-health-store
 *   - msUntilOpen   : ms until registration opens for the soonest active job,
 *                     or null when there is no upcoming job
 *
 * Outputs:
 *   - getCheapCheckInterval(ms)  → ms      (re-exported from cheap-check.js)
 *   - getDeepCheckInterval(ms)   → ?ms     (null when <30m → defer to existing T-30/10/2)
 *   - shouldRunCheapCheck(...)   → boolean
 *   - shouldRunDeepCheck(...)    → boolean
 */

'use strict';

const { HEALTH_STATES }                            = require('./connection-health');
const { getCheapCheckInterval, CHEAP_INTERVAL_MS } = require('./cheap-check');

// ─── Deep-check intervals (per spec) ────────────────────────────────────────

const TWELVE_H = 12 * 60 * 60 * 1000;
const SIX_H    =  6 * 60 * 60 * 1000;
const TWO_H    =  2 * 60 * 60 * 1000;
const THIRTY_M = 30 * 60 * 1000;

const DEEP_INTERVAL_MS = Object.freeze({
  FAR:      6 * 60 * 60 * 1000, // > 12 h
  MID:      3 * 60 * 60 * 1000, // 12 h – 6 h
  NEAR:     1 * 60 * 60 * 1000, //  6 h – 2 h
  IMMINENT: 30 * 60 * 1000,     //  2 h – 30 m
  // < 30 m → null (defer to existing T-30/T-10/T-2 checkpoints)
});

/**
 * Pure: pick the deep-check interval for a given proximity to open.
 *
 * Returns NULL when we are inside the existing T-30/T-10/T-2 checkpoint
 * window — Stage-1 audit showed those are already wired in
 * src/scheduler/auto-preflight.js, so the policy explicitly defers to
 * them and refuses to schedule its own deep check that close to open.
 *
 * @param {?number} msUntilOpen
 * @returns {?number}
 */
function getDeepCheckInterval(msUntilOpen) {
  if (msUntilOpen == null || !Number.isFinite(msUntilOpen)) return DEEP_INTERVAL_MS.FAR;
  if (msUntilOpen > TWELVE_H) return DEEP_INTERVAL_MS.FAR;
  if (msUntilOpen > SIX_H)    return DEEP_INTERVAL_MS.MID;
  if (msUntilOpen > TWO_H)    return DEEP_INTERVAL_MS.NEAR;
  if (msUntilOpen > THIRTY_M) return DEEP_INTERVAL_MS.IMMINENT;
  return null; // defer to existing checkpoints
}

// ─── Reprobe floor for the disconnected state ───────────────────────────────
//
// Even when state is DISCONNECTED we don't want to hammer the endpoint.
// 60 s for cheap (a single HTTP ping is light) and 5 min for deep (a
// browser launch is heavy).
const MIN_CHEAP_REPROBE_MS = 60 * 1000;
const MIN_DEEP_REPROBE_MS  =  5 * 60 * 1000;

// ─── Decision functions (pure) ──────────────────────────────────────────────

/**
 * Should a cheap check run right now?
 *
 * Rules:
 *   1. If the record has never had a cheap check (lastCheapCheckAt == null)
 *      → YES.
 *   2. If currentState is DISCONNECTED → YES once MIN_CHEAP_REPROBE_MS has
 *      elapsed (we want fast reconnection confirmation).
 *   3. Otherwise → YES iff (now - lastCheapCheckAt) ≥ getCheapCheckInterval.
 *
 * @param {number} now
 * @param {object} health        ConnectionHealth record (or null)
 * @param {?number} msUntilOpen
 * @returns {boolean}
 */
function shouldRunCheapCheck(now, health, msUntilOpen) {
  const h        = health || {};
  const interval = getCheapCheckInterval(msUntilOpen);
  const last     = h.lastCheapCheckAt;

  if (last == null) return true;

  if (h.currentState === HEALTH_STATES.DISCONNECTED) {
    return (now - last) >= MIN_CHEAP_REPROBE_MS;
  }

  return (now - last) >= interval;
}

/**
 * Should a deep check run right now?
 *
 * Rules:
 *   1. If we are <30 m to open → NO.  Existing T-30/T-10/T-2 checkpoints
 *      own this window; we explicitly defer (getDeepCheckInterval == null).
 *   2. If the record has never had a deep check → YES.
 *   3. If currentState is DISCONNECTED → YES once MIN_DEEP_REPROBE_MS has
 *      elapsed since the last deep attempt.
 *   4. If currentState is AT_RISK → YES once HALF the normal interval has
 *      elapsed since the last deep attempt (faster recovery, still capped
 *      to avoid browser spam).
 *   5. Otherwise → YES iff (now - lastDeepCheckAt) ≥ getDeepCheckInterval.
 *
 * @param {number}  now
 * @param {object}  health
 * @param {?number} msUntilOpen
 * @returns {boolean}
 */
function shouldRunDeepCheck(now, health, msUntilOpen) {
  const interval = getDeepCheckInterval(msUntilOpen);
  if (interval == null) return false;          // <30 m → defer to existing checkpoints

  const h    = health || {};
  const last = h.lastDeepCheckAt;
  if (last == null) return true;

  // Stage 8 — bring-forward escalation.  Two consecutive cheap-check
  // failures override the proximity cadence so we get a deep verification
  // sooner than the normal interval would allow.  The MIN_DEEP_REPROBE_MS
  // floor still applies, so even a constant stream of cheap failures can
  // launch at most one deep check every 5 minutes.  deep-check.js resets
  // consecutiveCheapFailures to 0 the instant any deep run completes, so
  // this rule cannot self-perpetuate — two MORE cheap misses are required
  // before another escalated launch is allowed.
  if ((h.consecutiveCheapFailures || 0) >= 2) {
    return (now - last) >= MIN_DEEP_REPROBE_MS;
  }

  if (h.currentState === HEALTH_STATES.DISCONNECTED) {
    return (now - last) >= MIN_DEEP_REPROBE_MS;
  }
  if (h.currentState === HEALTH_STATES.AT_RISK) {
    return (now - last) >= Math.max(interval / 2, MIN_DEEP_REPROBE_MS);
  }

  return (now - last) >= interval;
}

module.exports = {
  // Deep-check policy
  DEEP_INTERVAL_MS,
  getDeepCheckInterval,
  // Cheap-check policy (re-exported so callers have a single import surface)
  CHEAP_INTERVAL_MS,
  getCheapCheckInterval,
  // Reprobe floors (exported for tests / reasoning)
  MIN_CHEAP_REPROBE_MS,
  MIN_DEEP_REPROBE_MS,
  // Decision functions
  shouldRunCheapCheck,
  shouldRunDeepCheck,
};
