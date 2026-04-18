/**
 * Connection-Health Model — STAGE 2 (pure state, no execution).
 *
 * This module defines the data model and classification rules for the new
 * end-to-end auto connection-check feature.  It is intentionally:
 *
 *   - PURE: no timers, no Playwright, no scheduler hooks, no side effects.
 *   - ISOLATED: nothing in src/scheduler, src/bot, src/web imports this yet.
 *   - ADDITIVE: does not change existing health objects (auth-state.json,
 *     sniper-state.json, failures table) — it sits alongside them.
 *
 * Later stages will:
 *   Stage 3 — populate `lastCheapCheckAt` from a new cheap session check.
 *   Stage 4 — populate `lastDeepCheckAt` / `lastDeepSuccessAt` from an
 *             isolated deep-preflight wrapper.
 *   Stage 5 — define cadence policy as pure functions in this file's
 *             companion (still no scheduler wiring).
 *   Stage 6 — wire reads/writes into the scheduler tick (background only).
 *
 * Booking logic is NEVER affected by anything in this module.
 */

'use strict';

// ─── HealthState enum ───────────────────────────────────────────────────────

/**
 * @typedef {'healthy'|'degraded'|'at_risk'|'disconnected'} HealthState
 *
 * healthy      — recent deep check passed; cheap checks also passing.
 * degraded     — cheap checks passing but the most recent deep check is
 *                stale (older than the freshness window for the current
 *                proximity to open).  No known failure — just unverified.
 * at_risk      — most recent deep check FAILED for a non-auth reason
 *                (schedule load, row match, modal mismatch, etc.).
 * disconnected — auth/session is invalid (cheap check returned a login
 *                redirect, or a deep check failed at the auth phase).
 */
const HEALTH_STATES = Object.freeze({
  HEALTHY:      'healthy',
  DEGRADED:     'degraded',
  AT_RISK:      'at_risk',
  DISCONNECTED: 'disconnected',
});

// ─── Failure-reason taxonomy (used by Stages 3 & 4) ─────────────────────────
//
// Kept narrow on purpose — these map to the four states above without any
// fuzzy classification.  Anything not in this list is reported as 'unknown'
// and does NOT change state on its own.
const FAILURE_REASONS = Object.freeze({
  AUTH_REDIRECT:     'auth_redirect',     // cheap or deep saw a login redirect
  SESSION_EXPIRED:   'session_expired',   // FW/Daxko returned 401/expired
  SCHEDULE_LOAD:     'schedule_load',     // schedule URL did not load
  ROW_NOT_FOUND:     'row_not_found',     // deep: target class row missing
  MODAL_MISMATCH:    'modal_mismatch',    // deep: wrong modal / no modal
  NETWORK:           'network',           // transport-level failure
  UNKNOWN:           'unknown',
});

// ─── Default / empty record ─────────────────────────────────────────────────

/**
 * @typedef {Object} ConnectionHealth
 * @property {?number} lastCheapCheckAt    — epoch ms of most recent cheap check (any outcome)
 * @property {?number} lastDeepCheckAt     — epoch ms of most recent deep check  (any outcome)
 * @property {?number} lastDeepSuccessAt   — epoch ms of most recent SUCCESSFUL deep check
 * @property {?number} lastFailureAt       — epoch ms of most recent failure (cheap or deep)
 * @property {?string} lastFailureReason   — one of FAILURE_REASONS values, or null
 * @property {HealthState} currentState    — derived state; 'degraded' until first deep success
 */

function emptyHealth() {
  return {
    lastCheapCheckAt:   null,
    lastDeepCheckAt:    null,
    lastDeepSuccessAt:  null,
    lastFailureAt:      null,
    lastFailureReason:  null,
    currentState:       HEALTH_STATES.DEGRADED,
  };
}

// ─── Freshness windows ──────────────────────────────────────────────────────
//
// How "stale" a deep success can be before the connection drops from
// healthy → degraded.  Tighter windows as we approach open.  These are
// CONSTANTS only — Stage 5 will define the matching cadence functions.
const DEEP_FRESHNESS_MS = Object.freeze({
  FAR:      6 * 60 * 60 * 1000,  // > 12 h until open: a 6 h-old deep is still healthy
  MID:      3 * 60 * 60 * 1000,  // 12 h – 6 h
  NEAR:     1 * 60 * 60 * 1000,  // 6 h – 2 h
  IMMINENT: 30 * 60 * 1000,      // 2 h – 30 m
});

/**
 * Pick the freshness threshold for a given proximity to open.
 *
 * @param {?number} msUntilOpen — milliseconds until registration opens, or null.
 *                                Null means "no upcoming job" → use the FAR window.
 * @returns {number}
 */
function deepFreshnessThresholdFor(msUntilOpen) {
  if (msUntilOpen == null || !Number.isFinite(msUntilOpen)) return DEEP_FRESHNESS_MS.FAR;
  if (msUntilOpen > 12 * 60 * 60 * 1000) return DEEP_FRESHNESS_MS.FAR;
  if (msUntilOpen >  6 * 60 * 60 * 1000) return DEEP_FRESHNESS_MS.MID;
  if (msUntilOpen >  2 * 60 * 60 * 1000) return DEEP_FRESHNESS_MS.NEAR;
  return DEEP_FRESHNESS_MS.IMMINENT;
}

// ─── Pure classifier: data → HealthState ────────────────────────────────────

/**
 * Derive currentState from the rest of the record + proximity to open.
 *
 * Rules (evaluated in order):
 *   1. lastFailureReason ∈ {AUTH_REDIRECT, SESSION_EXPIRED} AND that failure
 *      is more recent than lastDeepSuccessAt → DISCONNECTED.
 *   2. lastDeepCheckAt > lastDeepSuccessAt (i.e. the most recent deep check
 *      was a failure) → AT_RISK.
 *   3. lastDeepSuccessAt within the freshness window for msUntilOpen → HEALTHY.
 *   4. Otherwise → DEGRADED.
 *
 * Pure function.  No I/O, no timers.
 *
 * @param {ConnectionHealth} health
 * @param {?number}          msUntilOpen
 * @param {number}           [now=Date.now()]
 * @returns {HealthState}
 */
function classifyHealth(health, msUntilOpen, now = Date.now()) {
  const h = health || emptyHealth();

  const isAuthFailure =
       h.lastFailureReason === FAILURE_REASONS.AUTH_REDIRECT
    || h.lastFailureReason === FAILURE_REASONS.SESSION_EXPIRED;

  if (isAuthFailure
      && h.lastFailureAt != null
      && (h.lastDeepSuccessAt == null || h.lastFailureAt > h.lastDeepSuccessAt)) {
    return HEALTH_STATES.DISCONNECTED;
  }

  if (h.lastDeepCheckAt != null
      && (h.lastDeepSuccessAt == null || h.lastDeepCheckAt > h.lastDeepSuccessAt)) {
    return HEALTH_STATES.AT_RISK;
  }

  if (h.lastDeepSuccessAt != null) {
    const ageMs = now - h.lastDeepSuccessAt;
    if (ageMs <= deepFreshnessThresholdFor(msUntilOpen)) {
      return HEALTH_STATES.HEALTHY;
    }
  }

  return HEALTH_STATES.DEGRADED;
}

/**
 * Return a copy of `health` with `currentState` recomputed.  Pure.
 */
function withDerivedState(health, msUntilOpen, now = Date.now()) {
  const next = { ...(health || emptyHealth()) };
  next.currentState = classifyHealth(next, msUntilOpen, now);
  return next;
}

module.exports = {
  HEALTH_STATES,
  FAILURE_REASONS,
  DEEP_FRESHNESS_MS,
  emptyHealth,
  deepFreshnessThresholdFor,
  classifyHealth,
  withDerivedState,
};
