// CJS runtime mirror of the TypeScript taxonomy defined in:
//   client/src/lib/readinessTypes.ts
//   client/src/lib/failureTypes.ts
//   client/src/lib/failureMapper.ts
//   client/src/lib/readinessResolver.ts
//
// This module is the server-side version used by register-pilates.js.
// The client-side TS files are the canonical source of type names —
// this file must stay in sync with them.

const fs   = require('fs');
const path = require('path');

// ── State file ────────────────────────────────────────────────────────────────
const DATA_DIR        = path.resolve(__dirname, '../data');
const STATE_FILE_PATH = path.join(DATA_DIR, 'sniper-state.json');

// ── FailureType → ReadinessImpact map ────────────────────────────────────────
// Mirrors failureMapper.ts : failureToReadinessImpact()
function failureImpact(failureType) {
  switch (failureType) {
    case 'AUTH_LOGIN_FAILED':
    case 'AUTH_RESTORE_FAILED':
      return { session: 'SESSION_REQUIRED' };

    case 'AUTH_SESSION_EXPIRED':
    case 'MODAL_LOGIN_REQUIRED':
      return { session: 'SESSION_EXPIRED', action: 'ACTION_BLOCKED' };

    case 'AUTH_SURFACE_MISMATCH':
      return { session: 'SESSION_UNKNOWN' };

    case 'NAVIGATION_TIMEOUT':
    case 'NAVIGATION_FAILED':
      return { discovery: 'DISCOVERY_FAILED', action: 'ACTION_BLOCKED' };

    case 'DISCOVERY_EMPTY':
    case 'DISCOVERY_FILTER_FAILED':
    case 'DISCOVERY_AMBIGUOUS':
      return { discovery: 'DISCOVERY_FAILED' };

    case 'VERIFY_MISMATCH':
    case 'VERIFY_AMBIGUOUS':
    case 'VERIFY_TIME_MISMATCH':
    case 'VERIFY_INSTRUCTOR_MISMATCH':
    case 'VERIFY_TITLE_MISMATCH':
      return { discovery: 'DISCOVERY_FAILED' };

    case 'MODAL_NOT_OPENED':
    case 'MODAL_TIMEOUT':
    case 'MODAL_ACTION_NOT_FOUND':
    case 'MODAL_ACTION_AMBIGUOUS':
      return { action: 'ACTION_BLOCKED' };

    case 'ACTION_NOT_FOUND':
    case 'ACTION_TIMEOUT':
    case 'ACTION_FORCE_CLICK_FAILED':
      return { action: 'ACTION_BLOCKED' };

    case 'ACTION_FORCE_CLICK_USED':
      return {};  // soft fallback — no hard block

    case 'CONFIRMATION_FAILED':
    case 'POST_CLICK_RESULT_AMBIGUOUS':
    case 'WAITLIST_ONLY':
    case 'CAPACITY_FULL':
      return { action: 'ACTION_BLOCKED' };

    case 'SYSTEM_EXCEPTION':
      return {
        session:   'SESSION_UNKNOWN',
        discovery: 'DISCOVERY_FAILED',
        action:    'ACTION_BLOCKED',
      };

    default:
      return {};
  }
}

// ── Sniper state resolver ─────────────────────────────────────────────────────
// Mirrors readinessResolver.ts : resolveSniperState()
function resolveState(bundle, runtime = {}) {
  if (runtime.recovering)  return 'SNIPER_RECOVERY_ACTIVE';
  if (runtime.confirming)  return 'SNIPER_CONFIRMING';
  if (runtime.booking)     return 'SNIPER_BOOKING';
  if (runtime.armed)       return 'SNIPER_ARMED';

  if (bundle.session === 'SESSION_REQUIRED' || bundle.session === 'SESSION_EXPIRED') {
    return 'SNIPER_BLOCKED_AUTH';
  }
  if (bundle.discovery === 'DISCOVERY_FAILED') return 'SNIPER_BLOCKED_DISCOVERY';
  if (bundle.action    === 'ACTION_BLOCKED')   return 'SNIPER_BLOCKED_ACTION';

  if (
    bundle.session   === 'SESSION_READY'   &&
    bundle.discovery === 'DISCOVERY_READY' &&
    bundle.action    === 'ACTION_READY'
  ) return 'SNIPER_READY';

  return 'SNIPER_WAITING';
}

// ── Run-state lifecycle ───────────────────────────────────────────────────────

function createRunState(jobId) {
  return {
    runId:       new Date().toISOString(),
    jobId:       jobId || null,
    phase:       'AUTH',
    bundle: {
      session:   'SESSION_UNKNOWN',
      discovery: 'DISCOVERY_NOT_TESTED',
      action:    'ACTION_NOT_TESTED',
    },
    sniperState: 'SNIPER_WAITING',
    events:      [],
    updatedAt:   new Date().toISOString(),
  };
}

// Advances the current phase label (informational only — does not change bundle).
function advance(state, phase) {
  state.phase     = phase;
  state.updatedAt = new Date().toISOString();
}

// Appends an event and applies the readiness impact of the failure to the bundle.
// failureType may be null for informational (non-failure) events.
function emitEvent(state, phase, failureType, message, extra = {}) {
  const event = {
    phase,
    failureType: failureType || null,
    message:     message || null,
    timestamp:   new Date().toISOString(),
    screenshot:  extra.screenshot || null,
    evidence:    extra.evidence   || null,
  };
  state.events.push(event);
  state.phase     = phase;
  state.updatedAt = event.timestamp;

  if (failureType) {
    const impact = failureImpact(failureType);
    if (impact.session)   state.bundle.session   = impact.session;
    if (impact.discovery) state.bundle.discovery = impact.discovery;
    if (impact.action)    state.bundle.action    = impact.action;
  }

  state.sniperState = resolveState(state.bundle);
}

// Marks the run as fully successful — all three readiness dimensions confirmed.
function emitSuccess(state) {
  const ts = new Date().toISOString();
  state.bundle = {
    session:   'SESSION_READY',
    discovery: 'DISCOVERY_READY',
    action:    'ACTION_READY',
  };
  state.sniperState = 'SNIPER_READY';
  state.phase       = 'CONFIRMATION';
  state.updatedAt   = ts;
  state.events.push({
    phase:       'CONFIRMATION',
    failureType: null,
    message:     'Booking completed successfully',
    timestamp:   ts,
    screenshot:  null,
    evidence:    null,
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveState(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[sniper-readiness] saveState failed:', e.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
  } catch (e) {
    console.warn('[sniper-readiness] loadState failed:', e.message);
    return null;
  }
}

// ── Tick-skip event ───────────────────────────────────────────────────────────
// Called by the scheduler tick when it decides to skip a warmup-phase run
// based on the current readiness state.  Appends a SYSTEM event to the
// existing sniper-state.json WITHOUT resetting the readiness bundle —
// the prior run's analysis stays intact; the skip is just added as evidence.

function emitTickSkip(jobId, reason, message) {
  try {
    const state = loadState();
    if (!state) {
      // No prior state file — nothing to annotate. Scheduler will create one
      // on the next actual run.
      console.log('[sniper-readiness] emitTickSkip: no state file yet, skip annotation skipped.');
      return;
    }
    // Update jobId if known and not already set from a real run.
    if (jobId && !state.jobId) state.jobId = jobId;

    const ts = new Date().toISOString();
    const event = {
      phase:       'SYSTEM',
      failureType: reason || null,
      message:     message || `Tick skipped: ${reason}`,
      timestamp:   ts,
      screenshot:  null,
      evidence:    null,
    };
    state.events = state.events || [];
    state.events.push(event);
    // Keep at most 20 events so the file stays small.
    if (state.events.length > 20) state.events = state.events.slice(-20);
    state.updatedAt = ts;
    saveState(state);
  } catch (e) {
    console.warn('[sniper-readiness] emitTickSkip failed:', e.message);
  }
}

module.exports = {
  createRunState,
  advance,
  emitEvent,
  emitSuccess,
  emitTickSkip,
  saveState,
  loadState,
  resolveState,
};
