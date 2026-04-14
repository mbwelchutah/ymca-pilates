// Canonical confirmed-ready model (Freshness + Confirmed-Ready Unification, Stage 1)
//
// Single source of truth for the question:
//   "Is this class actually confirmed ready for booking preparation right now?"
//
// All existing readiness signals (auth-state, readiness-state/sniper-state,
// schedule cache / classifier) are read here and composed into ONE normalized
// ConfirmedReadyState object.  Nothing downstream is wired yet — Stage 1 only
// defines and centralises the model.
//
// ── Shape ─────────────────────────────────────────────────────────────────────
//
// ConfirmedReadyState {
//   status  : "confirmed_ready" | "needs_refresh" | "needs_attention" | "unknown"
//
//   auth: {
//     daxkoValid             : boolean
//     familyworksValid       : boolean
//     bookingAccessConfirmed : boolean
//     checkedAt              : number | null   (epoch ms)
//     freshness              : "fresh" | "aging" | "stale" | "unknown"
//   }
//
//   classTruth: {
//     state      : "bookable" | "waitlist_available" | "full" | "not_found" | "unknown"
//     checkedAt  : number | null   (epoch ms, from cache entry capturedAt)
//     freshness  : "fresh" | "aging" | "stale" | "unknown"
//     source     : "cache" | "playwright" | "unknown"
//     isFuzzyMatch: boolean
//     confidence : number   (0–100, classifier confidence)
//   }
//
//   preflight: {
//     modalConfirmed : boolean
//     checkedAt      : number | null   (epoch ms)
//     freshness      : "fresh" | "aging" | "stale" | "unknown"
//   }
//
//   overall: {
//     checkedAt : number | null   (epoch ms — when this object was computed)
//     freshness : "fresh" | "aging" | "stale" | "unknown"
//     reason    : string
//   }
// }
//
// ── Freshness thresholds ──────────────────────────────────────────────────────
//
// auth:
//   fresh  < 30 min
//   aging  30 min – 2 h
//   stale  > 2 h
//
// classTruth (schedule cache):
//   fresh  < 30 min
//   aging  30 min – 4 h   (matches scheduleCache.js MAX_AGE_MS)
//   stale  > 4 h
//
// preflight/modal:
//   fresh  < 30 min
//   aging  30 min – 3 h
//   stale  > 3 h
//
// overall: derived from the stalest of the three sub-components that contributed
//          a non-unknown answer.
//
// ── Status rules ─────────────────────────────────────────────────────────────
//
// confirmed_ready  — auth connected + bookingAccessConfirmed + classTruth not
//                    full/not_found + preflight fresh or auth fresh
// needs_refresh    — truths exist but are aging or stale; structurally OK
// needs_attention  — auth invalid, booking access denied, or class unavailable
// unknown          — not enough fresh evidence to decide anything
//
// Log prefix: [confirmed-ready]

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Dependencies (loaded lazily where circular-risk exists) ───────────────────
//
// Stage 5 (auth-truth-unification) — canonical compliance confirmed:
//
//   _buildAuth()        reads auth-state.json ONLY via getAuthState()
//                       → canonical ✅  (no session-status.json or fw-session reads)
//
//   _buildPreflight()   reads readiness-state.json via loadReadiness()
//                       → correct — readiness-state is the normalized sniper model,
//                         NOT a legacy auth file.  Auth freshness for the preflight
//                         component comes from readiness.sniperUpdatedAt (Stage 3),
//                         which tracks when Playwright last ran, not record-write time.
//
//   _buildClassTruth()  reads fw-schedule-cache via classifyClass()
//                       → correct — schedule cache is class truth, not auth truth
//
//   fs calls            only on confirmed-ready-state.json (own state file)
//                       → no reads of session-status.json or familyworks-session.json

const { getAuthState }    = require('./auth-state');
const { loadReadiness }   = require('./readiness-state');

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'confirmed-ready-state.json');

// ── Freshness thresholds (ms) ─────────────────────────────────────────────────

const FRESHNESS = Object.freeze({
  auth: {
    fresh: 30  * 60 * 1000,   // < 30 min
    aging:  2  * 60 * 60 * 1000,  // 30 min – 2 h
    // > 2 h → stale
  },
  classTruth: {
    fresh: 30  * 60 * 1000,
    aging:  4  * 60 * 60 * 1000,  // 30 min – 4 h
  },
  preflight: {
    fresh: 30  * 60 * 1000,
    aging:  3  * 60 * 60 * 1000,  // 30 min – 3 h
  },
});

// ── Core freshness helper ─────────────────────────────────────────────────────

/**
 * Classify how fresh a timestamp is for a given domain.
 *
 * @param {number|null} checkedAtMs  Epoch ms, or null = never checked.
 * @param {'auth'|'classTruth'|'preflight'} domain
 * @returns {'fresh'|'aging'|'stale'|'unknown'}
 */
function computeFreshness(checkedAtMs, domain) {
  if (checkedAtMs == null || !Number.isFinite(checkedAtMs)) return 'unknown';
  const ageMs    = Date.now() - checkedAtMs;
  const thresholds = FRESHNESS[domain];
  if (!thresholds) return 'unknown';
  if (ageMs < thresholds.fresh) return 'fresh';
  if (ageMs < thresholds.aging) return 'aging';
  return 'stale';
}

// ── Auth sub-component builder ────────────────────────────────────────────────

function _buildAuth() {
  const a = getAuthState();

  // Stage 8 (auth freshness tightening):
  //
  // lastCheckedAt    — set whenever sessions are actively verified: HTTP ping
  //                    (auto-preflight fast path) or Playwright browser run.
  //                    This is the authoritative "we checked the session" timestamp.
  //
  // bookingAccessConfirmedAt — set when the booking modal surface was confirmed
  //                    reachable in a browser run.  It says the MODAL was there,
  //                    not that the underlying Daxko/FamilyWorks tokens are still
  //                    valid RIGHT NOW.  Using it to bump auth freshness would
  //                    falsely suggest the session was verified more recently
  //                    than it was.
  //
  // Conservative rule: auth.freshness is driven by lastCheckedAt alone.
  // bookingAccessConfirmedAt is only used as a fallback when lastCheckedAt has
  // never been set (e.g. first-run before any session check has completed).
  // We deliberately do NOT take Math.max(lastCheckedAt, bookingAccessConfirmedAt)
  // because that inflates freshness with a timestamp from a weaker check.
  let checkedAtMs = null;
  if (a.lastCheckedAt != null) {
    checkedAtMs = a.lastCheckedAt;
  } else if (a.bookingAccessConfirmedAt != null) {
    // No lastCheckedAt yet — use bookingAccess as the only available signal.
    // This is conservative: freshness reflects access confirmation, not a
    // dedicated session ping/check.
    checkedAtMs = a.bookingAccessConfirmedAt;
  }

  return {
    daxkoValid:             a.daxkoValid             ?? false,
    familyworksValid:       a.familyworksValid       ?? false,
    bookingAccessConfirmed: a.bookingAccessConfirmed ?? false,
    checkedAt:              checkedAtMs,
    freshness:              computeFreshness(checkedAtMs, 'auth'),
  };
}

// ── ClassTruth sub-component builder ──────────────────────────────────────────
//
// Reads from the schedule cache via classifyClass().  No job context → returns
// unknown.  When a job is provided the classifier is called synchronously.

function _buildClassTruth(job) {
  if (!job?.classTitle) {
    return {
      state:              'unknown',
      checkedAt:          null,
      freshness:          'unknown',
      cacheFileFreshness: 'unknown',
      source:             'unknown',
      isFuzzyMatch:       false,
      confidence:         0,
    };
  }

  let result;
  try {
    const { classifyClass } = require('../classifier/classTruth');
    result = classifyClass(job);
  } catch (e) {
    console.warn('[confirmed-ready] classifyClass failed:', e.message);
    return {
      state:              'unknown',
      checkedAt:          null,
      freshness:          'unknown',
      cacheFileFreshness: 'unknown',
      source:             'unknown',
      isFuzzyMatch:       false,
      confidence:         0,
    };
  }

  // Stage 2: classifier always provides `freshness` and `source` directly.
  // fetchedAt is kept for the checkedAt epoch ms conversion.
  // Stage 5: `cacheFileFreshness` (file-level savedAt) is now also propagated
  // so callers can distinguish entry-level freshness from whole-file freshness.
  const fetchedAtMs = result.fetchedAt
    ? new Date(result.fetchedAt).getTime()
    : null;

  return {
    state:              result.state,
    checkedAt:          Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
    freshness:          result.freshness          ?? 'unknown',  // per-entry (capturedAt)
    cacheFileFreshness: result.cacheFileFreshness ?? 'unknown',  // file-level (savedAt)
    source:             result.source             ?? 'unknown',
    isFuzzyMatch:       result.isFuzzyMatch       ?? false,
    confidence:         result.confidence         ?? 0,
  };
}

// ── Preflight sub-component builder ───────────────────────────────────────────
//
// Reads from readiness-state.json (the normalized sniper-state output).
// Modal "reachable" = booking surface was confirmed in a browser run.

function _buildPreflight() {
  const r = loadReadiness();

  if (!r) {
    return { modalConfirmed: false, checkedAt: null, freshness: 'unknown' };
  }

  // Stage 3 (keepalive-refresh honesty): use sniperUpdatedAt — the timestamp
  // of when Playwright last wrote sniper-state.json — for preflight freshness.
  // r.lastCheckedAt is the readiness-record computation time, which is bumped
  // by every keepalive/tick refresh even when no browser ran.  Using it would
  // falsely show modal truth as 'fresh' after a ping-only keepalive.
  // sniperUpdatedAt is absent on records written before this stage; fall back
  // to null (freshness: 'unknown') so old records degrade safely.
  const sniperUpdatedAtMs = r.sniperUpdatedAt
    ? new Date(r.sniperUpdatedAt).getTime()
    : null;
  const checkedAtMs = Number.isFinite(sniperUpdatedAtMs) ? sniperUpdatedAtMs : null;

  const modalConfirmed = r.modal === 'reachable';

  return {
    modalConfirmed,
    checkedAt: checkedAtMs,
    freshness: computeFreshness(checkedAtMs, 'preflight'),
  };
}

// ── Overall freshness derivation ──────────────────────────────────────────────
//
// Determined by the stalest sub-component that contributed a non-unknown answer.
// If all are unknown → overall is unknown.

const FRESHNESS_RANK = { fresh: 0, aging: 1, stale: 2, unknown: 3 };

function _worstFreshness(...values) {
  // Treat 'unknown' as worst only when ALL inputs are unknown.
  const nonUnknown = values.filter(v => v !== 'unknown');
  if (nonUnknown.length === 0) return 'unknown';
  return nonUnknown.reduce((worst, v) =>
    FRESHNESS_RANK[v] > FRESHNESS_RANK[worst] ? v : worst
  );
}

// ── Status derivation ─────────────────────────────────────────────────────────

function _deriveStatus(auth, classTruth, preflight) {
  // needs_attention: auth structurally broken or class definitively unavailable
  if (!auth.daxkoValid || !auth.familyworksValid) {
    // Only hard-block when the auth check is fresh enough to trust.
    if (auth.freshness === 'fresh' || auth.freshness === 'aging') {
      return { status: 'needs_attention', reason: 'Auth invalid — Daxko or FamilyWorks session not confirmed' };
    }
  }

  if (auth.bookingAccessConfirmed === false && auth.checkedAt != null &&
      (auth.freshness === 'fresh' || auth.freshness === 'aging')) {
    return { status: 'needs_attention', reason: 'Booking surface access was previously denied' };
  }

  if (classTruth.freshness !== 'unknown' &&
      (classTruth.state === 'full' && classTruth.freshness === 'fresh')) {
    return { status: 'needs_attention', reason: 'Class is currently full (fresh cache)' };
  }

  if (classTruth.freshness !== 'unknown' &&
      (classTruth.state === 'not_found' && classTruth.freshness === 'fresh')) {
    return { status: 'needs_attention', reason: 'Class not found on schedule (fresh cache)' };
  }

  // confirmed_ready: everything fresh and positive
  // Note (Stage 5): classTruth.freshness is per-entry (capturedAt) — it reflects
  // when this specific class row was last observed, not when the cache file was
  // last written.  classTruth.cacheFileFreshness (file-level savedAt) is available
  // here for future diagnostic use but is not used in gating decisions.
  const authOk       = auth.daxkoValid && auth.familyworksValid && auth.bookingAccessConfirmed;
  const classTruthOk = classTruth.state === 'bookable' || classTruth.state === 'waitlist_available';
  const freshEnough  = auth.freshness === 'fresh' || auth.freshness === 'aging';
  const classFresh   = classTruth.freshness === 'fresh' || classTruth.freshness === 'aging';
  const preflightOk  = preflight.modalConfirmed && (preflight.freshness === 'fresh' || preflight.freshness === 'aging');

  if (authOk && freshEnough && classTruthOk && classFresh && preflightOk) {
    return { status: 'confirmed_ready', reason: 'Auth, class availability, and modal all confirmed fresh' };
  }

  if (authOk && freshEnough && classTruthOk && classFresh) {
    return { status: 'confirmed_ready', reason: 'Auth and class availability confirmed; modal not yet probed' };
  }

  // needs_refresh: evidence exists but is aging/stale, or preflight missing
  if (auth.checkedAt != null) {
    return { status: 'needs_refresh', reason: 'Auth or class truth exists but is aging or incomplete' };
  }

  return { status: 'unknown', reason: 'Not enough fresh evidence to determine readiness' };
}

// ── Main export: compute ──────────────────────────────────────────────────────

/**
 * Compute the canonical ConfirmedReadyState for a job (or globally if no job given).
 *
 * This is a pure read — it does not trigger any browser launches, network
 * requests, or state mutations.  It composes what is already on disk.
 *
 * @param {{ classTitle?, dayOfWeek?, classTime?, instructor?, targetDate? }|null} job
 * @param {{ source?: 'ping'|'browser'|'tick'|'unknown' }} [options]
 *   source — what kind of validation triggered this refresh.
 *   'ping'    — HTTP session ping confirmed sessions alive; no browser ran.
 *   'browser' — full Playwright preflight/burst run completed.
 *   'tick'    — scheduler tick finally-block refresh (post booking attempt).
 *   'unknown' — source not specified (e.g. manual /api/preflight call).
 *   Recorded in overall.refreshSource so consumers can distinguish ping-only
 *   refreshes from browser-verified refreshes without inspecting timestamps.
 * @returns {ConfirmedReadyState}
 */
function computeConfirmedReadyState(job = null, { source = 'unknown' } = {}) {
  const auth       = _buildAuth();
  const classTruth = _buildClassTruth(job);
  const preflight  = _buildPreflight();

  const { status, reason } = _deriveStatus(auth, classTruth, preflight);

  const overallFreshness = _worstFreshness(auth.freshness, classTruth.freshness, preflight.freshness);

  return {
    status,
    auth,
    classTruth,
    preflight,
    overall: {
      checkedAt:     Date.now(),
      freshness:     overallFreshness,
      reason,
      refreshSource: source,   // Stage 6 — what type of check last wrote this file
    },
  };
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function loadConfirmedReadyState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function saveConfirmedReadyState(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[confirmed-ready] saveConfirmedReadyState failed:', e.message);
  }
}

/**
 * Compute + save the canonical state in one call.
 * @param {{ classTitle?, dayOfWeek?, classTime?, instructor?, targetDate? }|null} job
 * @param {{ source?: 'ping'|'browser'|'tick'|'unknown' }} [options]
 * @returns {ConfirmedReadyState}
 */
function refreshConfirmedReadyState(job = null, options = {}) {
  const state = computeConfirmedReadyState(job, options);
  saveConfirmedReadyState(state);
  return state;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  computeConfirmedReadyState,
  loadConfirmedReadyState,
  saveConfirmedReadyState,
  refreshConfirmedReadyState,
  computeFreshness,   // exported for use by downstream stages
  FRESHNESS,          // exported so downstream stages can reference thresholds
};
