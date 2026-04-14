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

  // Use the most recent of lastCheckedAt and bookingAccessConfirmedAt as the
  // authoritative "we last verified auth" timestamp.
  let checkedAtMs = null;
  if (a.lastCheckedAt != null)             checkedAtMs = a.lastCheckedAt;
  if (a.bookingAccessConfirmedAt != null) {
    checkedAtMs = checkedAtMs == null
      ? a.bookingAccessConfirmedAt
      : Math.max(checkedAtMs, a.bookingAccessConfirmedAt);
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
      state:       'unknown',
      checkedAt:   null,
      freshness:   'unknown',
      source:      'unknown',
      isFuzzyMatch: false,
      confidence:  0,
    };
  }

  let result;
  try {
    const { classifyClass } = require('../classifier/classTruth');
    result = classifyClass(job);
  } catch (e) {
    console.warn('[confirmed-ready] classifyClass failed:', e.message);
    return {
      state:       'unknown',
      checkedAt:   null,
      freshness:   'unknown',
      source:      'unknown',
      isFuzzyMatch: false,
      confidence:  0,
    };
  }

  // Stage 2: classifier now always provides `freshness` and `source` directly.
  // fetchedAt is kept for the checkedAt epoch ms conversion.
  const fetchedAtMs = result.fetchedAt
    ? new Date(result.fetchedAt).getTime()
    : null;

  return {
    state:        result.state,
    checkedAt:    Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
    freshness:    result.freshness ?? 'unknown',
    source:       result.source    ?? 'unknown',
    isFuzzyMatch: result.isFuzzyMatch ?? false,
    confidence:   result.confidence   ?? 0,
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

  const checkedAtMs = r.lastCheckedAt
    ? new Date(r.lastCheckedAt).getTime()
    : null;

  const modalConfirmed = r.modal === 'reachable';

  return {
    modalConfirmed,
    checkedAt: Number.isFinite(checkedAtMs) ? checkedAtMs : null,
    freshness: computeFreshness(Number.isFinite(checkedAtMs) ? checkedAtMs : null, 'preflight'),
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
 * @returns {ConfirmedReadyState}
 */
function computeConfirmedReadyState(job = null) {
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
      checkedAt: Date.now(),
      freshness: overallFreshness,
      reason,
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
 * @returns {ConfirmedReadyState}
 */
function refreshConfirmedReadyState(job = null) {
  const state = computeConfirmedReadyState(job);
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
