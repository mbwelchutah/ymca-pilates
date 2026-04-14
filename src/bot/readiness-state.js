// Persisted normalized readiness state (Stage 9B)
//
// Maintains a stable, human-readable readiness snapshot for the active job.
// Raw internal codes from sniper-state.json (SESSION_READY, DISCOVERY_FAILED,
// etc.) are mapped to clean state strings so the UI and confidence engine can
// consume them without knowing internal bot terminology.
//
// Shape written to src/data/readiness-state.json:
// {
//   lastCheckedAt   : ISO string,
//   jobId           : number,
//   classTitle      : string,
//   session         : "ready" | "error" | "unknown",
//   schedule        : "ready" | "error" | "unknown",
//   discovery       : "found" | "missing" | "unknown",
//   modal           : "reachable" | "blocked" | "unknown",
//   action          : "ready" | "not_open" | "blocked" | "waitlist" | "unknown",
//   source          : "background" | "manual" | "keepalive",
//   confidenceScore : integer 0–100   (Stage 9C),
//   confidenceLabel : "Ready" | "Almost ready" | "Needs attention" | "At risk"
// }
//
// Writers:
//   refreshReadiness()  — called by preflight-loop, /api/preflight, session-keepalive

'use strict';

const fs   = require('fs');
const path = require('path');

const { loadState }             = require('./sniper-readiness');
// Stage 6 (auth-truth-unification): session and schedule truth now come from
// getCanonicalAuthTruth() (auth-state.json) instead of the legacy files
// session-status.json (loadStatus) and familyworks-session.json (readFwStatus).
// Both sources are now replaced by this single canonical read.
const { getCanonicalAuthTruth } = require('./auth-state');
const { computeConfidence }     = require('./confidence');
// NOTE: confirmed-ready.js is NOT top-level required here because it also
// requires readiness-state.js (circular).  loadConfirmedReadyState is instead
// required lazily inside computeReadiness() to avoid Node's circular-dependency
// initialisation race (Stage 8).

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'readiness-state.json');

// ── File helpers ──────────────────────────────────────────────────────────────

function loadReadiness() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function saveReadiness(record) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn('[readiness-state] saveReadiness failed:', e.message);
  }
}

// ── Raw-code normalizers ──────────────────────────────────────────────────────

// sessionValid is boolean|null from getCanonicalAuthTruth() (auth-state.json).
// null means auth has never been checked — fall back to sniper bundle code.
function normalizeSession(bundleSession, sessionValid) {
  if (sessionValid === true)  return 'ready';
  if (sessionValid === false) return 'error';
  // Auth not yet checked — fall back to sniper bundle code.
  if (bundleSession === 'SESSION_READY')   return 'ready';
  if (bundleSession === 'SESSION_EXPIRED') return 'error';
  return 'unknown';
}

function normalizeSchedule(fwStatus) {
  if (fwStatus === 'FAMILYWORKS_READY')            return 'ready';
  if (fwStatus === 'FAMILYWORKS_SESSION_MISSING')  return 'error';
  if (fwStatus === 'FAMILYWORKS_SESSION_EXPIRED')  return 'error';
  return 'unknown';
}

function normalizeDiscovery(bundleDiscovery) {
  if (bundleDiscovery === 'DISCOVERY_READY')  return 'found';
  if (bundleDiscovery === 'DISCOVERY_FAILED') return 'missing';
  return 'unknown';
}

function normalizeModal(bundleModal) {
  if (bundleModal === 'MODAL_READY')          return 'reachable';
  if (bundleModal === 'MODAL_BLOCKED')        return 'blocked';
  if (bundleModal === 'MODAL_LOGIN_REQUIRED') return 'blocked';
  return 'unknown';
}

function normalizeAction(bundleAction) {
  if (bundleAction === 'ACTION_READY')    return 'ready';
  if (bundleAction === 'ACTION_BLOCKED')  return 'not_open';
  if (bundleAction === 'ACTION_WAITLIST') return 'waitlist';
  return 'unknown';
}

// ── Core: compute the normalized object from live state ───────────────────────

function computeReadiness({ jobId, classTitle, source }) {
  // Each source is loaded independently so a single failure produces partial
  // (unknown) readiness rather than crashing the whole snapshot (Stage 9I).
  let sniperState = null;
  try { sniperState = loadState(); } catch (e) {
    console.warn('[readiness-state] loadState failed (partial result):', e.message);
  }

  // Stage 6 (auth-truth-unification): session and schedule truth come from
  // the canonical auth source (auth-state.json) via getCanonicalAuthTruth().
  // This replaces the previous dual reads of session-status.json (loadStatus)
  // and familyworks-session.json (readFwStatus) which could disagree with each
  // other and with confirmed-ready.js, which always read auth-state.json.
  let canonicalAuth = null;
  try { canonicalAuth = getCanonicalAuthTruth(); } catch (e) {
    console.warn('[readiness-state] getCanonicalAuthTruth failed (partial result):', e.message);
  }
  // Stage 8 (diagnostic visibility): log canonical auth inputs so every
  // readiness computation cycle is observable in server output without
  // needing to curl the API.  sessionValid/fwStatusCode are the two values
  // that feed session: and schedule: respectively.
  console.log(
    `[readiness-state] canonical auth — sessionValid:${canonicalAuth?.sessionValid ?? 'null'}` +
    ` fwStatusCode:${canonicalAuth?.fwStatusCode ?? 'null'}` +
    ` (source:${source ?? 'unknown'})`
  );

  const bundle = sniperState?.bundle ?? {};

  const record = {
    lastCheckedAt:  new Date().toISOString(),
    // sniperUpdatedAt: when the underlying Playwright browser run last wrote
    // sniper-state.json.  This is distinct from lastCheckedAt (which is the
    // record-computation time, freshened on every keepalive/tick).
    // _buildPreflight() in confirmed-ready.js uses this for preflight.freshness
    // so modal truth age is honest rather than inflated by non-browser refreshes.
    sniperUpdatedAt: sniperState?.updatedAt ?? null,
    jobId:         jobId  ?? sniperState?.jobId  ?? null,
    classTitle:    classTitle ?? sniperState?.classTitle ?? null,
    // canonicalAuth.sessionValid: boolean|null from auth-state.json — replaces
    // session-status.json valid field.  Falls back to sniper bundle when null.
    session:       normalizeSession(bundle.session,   canonicalAuth?.sessionValid ?? null),
    // canonicalAuth.fwStatusCode: status string from auth-state.json — replaces
    // familyworks-session.json status field.
    schedule:      normalizeSchedule(canonicalAuth?.fwStatusCode ?? 'FAMILYWORKS_UNKNOWN'),
    discovery:     normalizeDiscovery(bundle.discovery),
    modal:         normalizeModal(bundle.modal),
    action:        normalizeAction(bundle.action),
    source:        source ?? 'unknown',
  };

  const { score, label } = computeConfidence(record);
  record.confidenceScore = score;
  record.confidenceLabel = label;

  // Stage 8 — attach schedule-cache freshness so GET /api/readiness consumers
  // (NowScreen trust line) can show when class schedule data is stale without
  // a separate API call.  Falls back to 'unknown' if confirmed-ready state
  // isn't available yet (e.g. server just started).
  // Lazy require breaks the confirmed-ready ↔ readiness-state circular dependency.
  // Stage 4 (write-order verification) — log the confirmed-ready file age so
  // it is verifiable that readiness is reading same-cycle truth after the
  // Stage 3 write-order fix.  A "same-cycle" read shows age < a few seconds;
  // a "lagged" read would show age equal to the previous run interval.
  let classTruthFreshness = 'unknown';
  try {
    const { loadConfirmedReadyState } = require('./confirmed-ready');
    const cr = loadConfirmedReadyState();
    if (cr?.classTruth?.freshness) classTruthFreshness = cr.classTruth.freshness;
    const crAgeMs = (cr?.overall?.checkedAt != null)
      ? Date.now() - cr.overall.checkedAt
      : null;
    const cycleLabel = (crAgeMs != null && crAgeMs < 5000) ? 'same-cycle' : 'prior-cycle';
    console.log(
      `[readiness-state] write-order check — confirmed-ready age: ` +
      `${crAgeMs != null ? crAgeMs + 'ms' : 'unknown'} (${cycleLabel}), ` +
      `classTruthFreshness: ${classTruthFreshness}`
    );
  } catch { /* non-fatal — readiness-state must not crash */ }
  record.classTruthFreshness = classTruthFreshness;

  return record;
}

// ── Convenience: compute + save in one call ───────────────────────────────────

function refreshReadiness({ jobId = null, classTitle = null, source = 'unknown' } = {}) {
  const record = computeReadiness({ jobId, classTitle, source });
  saveReadiness(record);
  // Stage 8 (diagnostic visibility): emit computed output alongside the canonical
  // auth input log so a single log scan shows the full pipeline per cycle.
  console.log(
    `[readiness-state] computed — session:${record.session} schedule:${record.schedule}` +
    ` discovery:${record.discovery} modal:${record.modal} action:${record.action}` +
    ` confidence:${record.confidenceScore} (${record.confidenceLabel})`
  );
  return record;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { loadReadiness, saveReadiness, computeReadiness, refreshReadiness };
