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

const { loadState }         = require('./sniper-readiness');
const { loadStatus }        = require('./session-check');
const { computeConfidence } = require('./confidence');
// NOTE: confirmed-ready.js is NOT top-level required here because it also
// requires readiness-state.js (circular).  loadConfirmedReadyState is instead
// required lazily inside computeReadiness() to avoid Node's circular-dependency
// initialisation race (Stage 8).

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'readiness-state.json');
const FW_FILE    = path.join(DATA_DIR, 'familyworks-session.json');

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

function normalizeSession(bundleSession, sessionStatusValid) {
  // Prefer the live session-status.json result when available.
  if (sessionStatusValid === true)  return 'ready';
  if (sessionStatusValid === false) return 'error';
  // Fall back to sniper bundle code.
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

// ── FamilyWorks session reader ────────────────────────────────────────────────
// Mirrors the logic in /api/session-status: treats entries older than 6 h as unknown.

function readFwStatus() {
  try {
    if (!fs.existsSync(FW_FILE)) return 'FAMILYWORKS_SESSION_MISSING';
    const raw   = JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
    const ageMs = Date.now() - new Date(raw.checkedAt || 0).getTime();
    if (ageMs >= 6 * 3600 * 1000) return 'FAMILYWORKS_UNKNOWN'; // stale
    return raw.status || 'FAMILYWORKS_UNKNOWN';
  } catch { return 'FAMILYWORKS_UNKNOWN'; }
}

// ── Core: compute the normalized object from live state ───────────────────────

function computeReadiness({ jobId, classTitle, source }) {
  // Each source is loaded independently so a single failure produces partial
  // (unknown) readiness rather than crashing the whole snapshot (Stage 9I).
  let sniperState = null;
  try { sniperState = loadState(); } catch (e) {
    console.warn('[readiness-state] loadState failed (partial result):', e.message);
  }

  let sessionStatus = null;
  try { sessionStatus = loadStatus(); } catch (e) {
    console.warn('[readiness-state] loadStatus failed (partial result):', e.message);
  }

  const bundle   = sniperState?.bundle ?? {};
  const fwStatus = readFwStatus();

  const record = {
    lastCheckedAt: new Date().toISOString(),
    jobId:         jobId  ?? sniperState?.jobId  ?? null,
    classTitle:    classTitle ?? sniperState?.classTitle ?? null,
    session:       normalizeSession(bundle.session,   sessionStatus?.valid ?? null),
    schedule:      normalizeSchedule(fwStatus),
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
  let classTruthFreshness = 'unknown';
  try {
    const { loadConfirmedReadyState } = require('./confirmed-ready');
    const cr = loadConfirmedReadyState();
    if (cr?.classTruth?.freshness) classTruthFreshness = cr.classTruth.freshness;
  } catch { /* non-fatal — readiness-state must not crash */ }
  record.classTruthFreshness = classTruthFreshness;

  return record;
}

// ── Convenience: compute + save in one call ───────────────────────────────────

function refreshReadiness({ jobId = null, classTitle = null, source = 'unknown' } = {}) {
  const record = computeReadiness({ jobId, classTitle, source });
  saveReadiness(record);
  return record;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { loadReadiness, saveReadiness, computeReadiness, refreshReadiness };
