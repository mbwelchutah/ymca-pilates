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
      return { session: 'SESSION_EXPIRED', action: 'ACTION_BLOCKED' };

    case 'MODAL_LOGIN_REQUIRED':
      return { modal: 'MODAL_LOGIN_REQUIRED', session: 'SESSION_EXPIRED', action: 'ACTION_BLOCKED' };

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
      return { modal: 'MODAL_BLOCKED', action: 'ACTION_BLOCKED' };

    case 'MODAL_ACTION_NOT_FOUND':
    case 'MODAL_ACTION_AMBIGUOUS':
      return { modal: 'MODAL_READY', action: 'ACTION_BLOCKED' };

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
  // Carry forward any existing lastPreflightSnapshot so that booking and
  // scheduler runs do not erase a user-triggered preflight result that was
  // saved between runs.  One disk read here is acceptable; createRunState is
  // called only once at the start of each bot run.
  const prior = loadState();
  return {
    runId:          new Date().toISOString(),
    jobId:          jobId || null,
    phase:          'AUTH',
    bundle: {
      session:      'SESSION_UNKNOWN',
      discovery:    'DISCOVERY_NOT_TESTED',
      action:       'ACTION_NOT_TESTED',
      modal:        'MODAL_NOT_TESTED',
    },
    sniperState:    'SNIPER_WAITING',
    // Set to the event timestamp whenever an auth-block impact is applied by
    // a real booking run.  emitTickSkip() never writes this field, so the gate
    // in tick.js always reflects when the session actually failed, not when
    // the last skip event was written.
    authBlockedAt:  null,
    // Timing data recorded by the bot during sniper / booking runs.
    // null when no timing was captured (e.g. preflight-only or early-exit runs).
    timing:         null,
    // Stage 3: derived first-attempt metrics (human-readable durations).
    // Computed by deriveTimingMetrics() from the raw timing snapshot.
    timingMetrics:  null,
    events:         [],
    updatedAt:      new Date().toISOString(),
    // Most recent failure/uncertain screenshot from the run (set by logRunSummary).
    // Stored as a DB-style ref: "YYYY-MM-DD/filename.png" (new) or "filename.png" (legacy).
    screenshotPath: null,
    // Stage 10E — true only in the window between a Register/Waitlist click and
    // receiving the confirmation result.  Set by register-pilates.js after each
    // button click and cleared when checkBookingConfirmed() resolves.
    // Allows computeExecutionTiming() to report phase='confirming' precisely.
    isConfirming: false,
    // Persisted across runs so the NowScreen badge survives page refreshes
    // and scheduler cycles.  Only savePreflightSnapshot() ever writes this.
    lastPreflightSnapshot: prior?.lastPreflightSnapshot ?? null,
  };
}

// Stores timing measurements captured during a run.
// data shape: {
//   bookingOpenAt:      ISO string — when the booking window was scheduled to open
//   cardFoundAt:        ISO string | null — when the target class card appeared
//   actionClickAt:      ISO string | null — when Register/Waitlist was clicked
//   openToCardMs:       number | null — ms between booking open and card appearing
//   openToClickMs:      number | null — ms between booking open and action click
//   pollAttemptsPostOpen: number — how many tab re-clicks happened after window opened
// }
function recordTiming(state, data) {
  state.timing    = data;
  state.updatedAt = new Date().toISOString();
}

// Stage 3: Stores derived first-attempt metrics alongside the raw timing data.
// metrics shape: return value of deriveTimingMetrics() from timing-metrics.js.
function recordTimingMetrics(state, metrics) {
  state.timingMetrics = metrics;
  state.updatedAt     = new Date().toISOString();
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
    if (impact.modal)     state.bundle.modal     = impact.modal;

    // Record when an auth-block was observed by a real booking run.
    // The scheduler readiness gate uses this field (not updatedAt) so that
    // skip-event writes cannot extend the suppression window.
    if (impact.session === 'SESSION_REQUIRED' || impact.session === 'SESSION_EXPIRED') {
      state.authBlockedAt = event.timestamp;
    }
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

// Updates lastSuccessfulPreflightAt to the current timestamp.
// Called by auto-preflight and preflight-loop after a successful automated run
// so that the /api/failures hideBefore logic applies to both manual and automated
// successful checks (Task #57).
function updateLastSuccessfulPreflightAt() {
  try {
    const s = loadState() || {};
    s.lastSuccessfulPreflightAt = new Date().toISOString();
    saveState(s);
  } catch (e) {
    console.warn('[sniper-readiness] updateLastSuccessfulPreflightAt failed:', e.message);
  }
}

// Persists a snapshot of the last user-triggered preflight result.
// Called from server.js after /api/preflight completes.  The snapshot
// survives page refreshes and lets the frontend restore the composite label
// and all per-stage detail subtitles without rerunning Check Now.
//
// details (optional): { authDetail, discoveryDetail, modalDetail, actionDetail }
function savePreflightSnapshot(status, details) {
  try {
    const s = loadState() || {};
    const now = new Date().toISOString();
    s.lastPreflightSnapshot = {
      checkedAt:       now,
      status:          status || 'unknown',
      authDetail:      details?.authDetail      ?? null,
      discoveryDetail: details?.discoveryDetail ?? null,
      modalDetail:     details?.modalDetail     ?? null,
      actionDetail:    details?.actionDetail    ?? null,
    };
    if (status === 'success') {
      s.lastSuccessfulPreflightAt = now;
    }
    saveState(s);
  } catch (e) {
    console.warn('[sniper-readiness] savePreflightSnapshot failed:', e.message);
  }
}

// ── Session-check event ───────────────────────────────────────────────────────
// Appended to sniper-state.json when the user runs Verify Session from the Now
// screen.  Appears in the Tools diagnostic event log so the user can see a
// timestamped history of manual session checks without needing to run Check Now.
// Does NOT reset the bundle or sniperState — only appends a SYSTEM event.

function emitSessionCheck(daxko, familyworks, detail) {
  try {
    const state = loadState();
    if (!state) return; // No prior state — nothing to annotate yet.
    const ts      = new Date().toISOString();
    const passed  = daxko === 'DAXKO_READY' && familyworks === 'FAMILYWORKS_READY';
    const fwOk    = familyworks === 'FAMILYWORKS_READY';
    const failure = !passed
      ? (daxko !== 'DAXKO_READY' ? 'AUTH_FAILED' : (!fwOk ? 'FW_SESSION_MISSING' : null))
      : null;
    const event = {
      phase:       'SESSION_VERIFY',
      failureType: failure,
      message:     detail || `Session check — Daxko: ${daxko}, FamilyWorks: ${familyworks}`,
      timestamp:   ts,
      screenshot:  null,
      evidence:    { daxko, familyworks },
    };
    state.events = state.events || [];
    state.events.push(event);
    if (state.events.length > 20) state.events = state.events.slice(-20);
    state.updatedAt = ts;
    saveState(state);
  } catch (e) {
    console.warn('[sniper-readiness] emitSessionCheck failed:', e.message);
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
  recordTiming,
  recordTimingMetrics,
  emitEvent,
  emitSuccess,
  emitTickSkip,
  emitSessionCheck,
  saveState,
  loadState,
  savePreflightSnapshot,
  updateLastSuccessfulPreflightAt,
  resolveState,
};
