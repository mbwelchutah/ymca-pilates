// Background preflight engine (Stage 9A)
//
// Runs a full safe preflight check at a continuous interval for active jobs
// that are approaching their booking window.  This complements auto-preflight.js
// (which fires exactly at –30 / –10 / –2 min) with a running check throughout
// the hours before the window opens, keeping the readiness state fresh without
// requiring any manual user action.
//
// Interval logic per job:
//   - Phase must be 'too_early'  (warmup/sniper/late are owned by other runners)
//   - Booking window must be within ACTIVE_HORIZON_MS  (default 24 h)
//   - Booking window must be more than AUTO_PREFLIGHT_OWNS_MS away (default 30 min)
//     — inside that zone, auto-preflight fires its own targeted checks
//   - At most one run every MIN_INTERVAL_MS per job (default 3 min)
//
// Only one job is checked per tick so back-to-back browser launches are avoided.
// Safe to call on every 60-second scheduler tick — it self-gates on all of the
// above and on the isActive / isLocked / running flags.
//
// Results flow into sniper-state.json through the existing sniper-readiness.js
// infrastructure (runBookingJob writes state on every preflight).
// This module also writes a lightweight summary to preflight-loop-state.json.
//
// Log prefix: [preflight-loop]

'use strict';

const fs   = require('fs');
const path = require('path');

const { getAllJobs }       = require('../db/jobs');
const { getPhase }         = require('./booking-window');
const { runBookingJob }    = require('../bot/register-pilates');
const { getDryRun }        = require('../bot/dry-run-state');
const { loadState }        = require('../bot/sniper-readiness');
const { loadStatus }       = require('../bot/session-check');
const { isLocked }             = require('../bot/auth-lock');
const { refreshReadiness }     = require('../bot/readiness-state');
const { computeExecutionTiming } = require('./execution-timing');
const { classifyFailure, computeRetry } = require('./retry-strategy');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS        = 3  * 60 * 1000;  // min time between runs per job
const ACTIVE_HORIZON_MS      = 24 * 60 * 60 * 1000; // only run within 24 h of window
const AUTO_PREFLIGHT_OWNS_MS = 30 * 60 * 1000;  // auto-preflight owns inside 30 min
const AUTH_BLOCK_STALE_MS    = 20 * 60 * 1000;  // mirror of auto-preflight / tick.js
const PREFLIGHT_TIMEOUT_MS   = 90 * 1000;        // max wall-time for one preflight run

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'preflight-loop-state.json');

// ── In-memory state ───────────────────────────────────────────────────────────

let running = false;

// Per-job timestamp of the last background run (epoch ms).
// Survives within a server session; resets on restart (acceptable — first run
// after restart will find lastCheckedAt in STATE_FILE for display purposes).
const lastRunAt = {};

// Stage 10B — Phase-aware retry tracking (in-memory, per job).
// nextRetryAt[jobId] : epoch ms — earliest time the next preflight may run.
//   Overrides MIN_INTERVAL_MS when a retry strategy has been computed.
//   Defaults to lastRunAt + MIN_INTERVAL_MS when not set.
// retryCount[jobId]  : consecutive failure count since last success.
const nextRetryAt = {};
const retryCount  = {};

// ── State file ────────────────────────────────────────────────────────────────

function loadLoopState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function saveLoopState(record) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn('[preflight-loop] saveLoopState failed:', e.message);
  }
}

// ── Timeout helper ────────────────────────────────────────────────────────────
// Rejects with a clear message if the wrapped promise does not settle in time.

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms / 1000}s (${label})`)),
      ms
    );
    promise.then(
      v  => { clearTimeout(timer); resolve(v); },
      e  => { clearTimeout(timer); reject(e);  }
    );
  });
}

// ── Public helpers ────────────────────────────────────────────────────────────

function isRunning() { return running; }

// ── Main entry point ──────────────────────────────────────────────────────────
// Call once per scheduler tick (every 60 s).
// isActive: true while a real booking run is open — stay out of the way.

async function runPreflightLoop({ isActive = false } = {}) {
  if (running) {
    console.log('[preflight-loop] skip:overlap — previous preflight still running.');
    return;
  }
  if (isActive) {
    console.log('[preflight-loop] skip:booking — live booking in progress; background checks paused.');
    return;
  }

  let jobs;
  try {
    jobs = getAllJobs().filter(j => j.is_active === 1);
  } catch (err) {
    console.error('[preflight-loop] error:load-jobs —', err.message);
    return;
  }
  if (jobs.length === 0) return;

  console.log(`[preflight-loop] tick:start — ${jobs.length} active job(s).`);

  // Load auth state once — shared across all jobs this tick.
  const sniperState   = loadState();
  const sessionStatus = loadStatus();

  for (const dbJob of jobs) {
    // ── Phase gate ──────────────────────────────────────────────────────────
    let phaseResult;
    try {
      phaseResult = getPhase({
        id:         dbJob.id,
        classTitle: dbJob.class_title,
        classTime:  dbJob.class_time,
        instructor: dbJob.instructor  || null,
        dayOfWeek:  dbJob.day_of_week,
        targetDate: dbJob.target_date || null,
      });
    } catch { continue; }

    const { phase, msUntilOpen } = phaseResult;

    if (phase !== 'too_early') continue;
    if (msUntilOpen > ACTIVE_HORIZON_MS)      continue; // too far away — session-keepalive covers auth
    if (msUntilOpen <= AUTO_PREFLIGHT_OWNS_MS) continue; // auto-preflight owns inside 30 min

    // ── Interval gate (Stage 10B: phase-aware) ──────────────────────────────
    // Use nextRetryAt[jobId] when a retry strategy has set it; fall back to
    // the fixed MIN_INTERVAL_MS so first-boot behaviour is unchanged.
    const retryGate = nextRetryAt[dbJob.id] ?? ((lastRunAt[dbJob.id] ?? 0) + MIN_INTERVAL_MS);
    if (Date.now() < retryGate) continue;

    // ── Auth-block gate ─────────────────────────────────────────────────────
    if (isLocked()) {
      console.log(`[preflight-loop] skip:auth-lock — Job #${dbJob.id} (concurrent operation in progress).`);
      continue;
    }

    if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH') {
      const refTime = sniperState.authBlockedAt || sniperState.updatedAt;
      if (refTime) {
        const age = Date.now() - new Date(refTime).getTime();
        if (age < AUTH_BLOCK_STALE_MS) {
          const minAgo = Math.round(age / 60000);
          console.log(`[preflight-loop] skip:auth-blocked — Job #${dbJob.id} (SNIPER_BLOCKED_AUTH ${minAgo} min ago).`);
          continue;
        }
      }
    }

    if (sessionStatus?.valid === false && sessionStatus.checkedAt) {
      const age = Date.now() - new Date(sessionStatus.checkedAt).getTime();
      if (age < AUTH_BLOCK_STALE_MS) {
        const minAgo = Math.round(age / 60000);
        console.log(`[preflight-loop] skip:session-failed — Job #${dbJob.id} (session check failed ${minAgo} min ago).`);
        continue;
      }
    }

    // ── Run ─────────────────────────────────────────────────────────────────
    running = true;
    lastRunAt[dbJob.id] = Date.now();

    const minsUntilOpen = Math.round(msUntilOpen / 60000);

    // Stage 10A — log execution timing phase alongside the scheduler phase.
    let execPhase = 'unknown';
    try {
      const et = computeExecutionTiming(dbJob);
      execPhase = et.phase;
    } catch (_) {}

    console.log(
      `[preflight-loop] run:start — Job #${dbJob.id} (${dbJob.class_title}), ` +
      `${minsUntilOpen} min until window opens, execution phase: ${execPhase}.`
    );

    const startedAt = new Date().toISOString();
    try {
      const result = await withTimeout(
        runBookingJob({
          id:          dbJob.id,
          classTitle:  dbJob.class_title,
          classTime:   dbJob.class_time,
          instructor:  dbJob.instructor  || null,
          dayOfWeek:   dbJob.day_of_week,
          targetDate:  dbJob.target_date || null,
          maxAttempts: 1,
        }, { preflightOnly: true, dryRun: getDryRun() }),
        PREFLIGHT_TIMEOUT_MS,
        `Job #${dbJob.id} preflight`
      );

      const outcome = result.status === 'success' ? 'pass' : 'fail';
      console.log(`[preflight-loop] run:result — Job #${dbJob.id} ${outcome}: ${result.message}`);

      refreshReadiness({ jobId: dbJob.id, classTitle: dbJob.class_title, source: 'background' });

      // Stage 10B — compute phase-aware retry context from outcome.
      const failureType = classifyFailure(result);
      let retryContext  = null;

      if (failureType) {
        // Failure: update consecutive count and plan next retry.
        retryCount[dbJob.id] = (retryCount[dbJob.id] ?? 0) + 1;
        const decision = computeRetry({
          failureType,
          executionPhase: execPhase,
          attemptNumber:  retryCount[dbJob.id],
        });
        nextRetryAt[dbJob.id] = Date.now() + decision.retryDelayMs;
        retryContext = {
          failureType,
          attemptNumber:  retryCount[dbJob.id],
          retryDelayMs:   decision.retryDelayMs,
          phase:          execPhase,
          shouldRetry:    decision.shouldRetry,
          note:           decision.note,
        };
        console.log(
          `[preflight-loop] retry:plan — Job #${dbJob.id} ` +
          `failureType=${failureType} phase=${execPhase} ` +
          `attempt=${retryCount[dbJob.id]} ` +
          `retryIn=${Math.round(decision.retryDelayMs / 1000)}s ` +
          `(${decision.note})`
        );
      } else {
        // Success: reset consecutive failure count; next run at normal cadence.
        retryCount[dbJob.id]  = 0;
        nextRetryAt[dbJob.id] = Date.now() + MIN_INTERVAL_MS;
      }

      saveLoopState({
        lastCheckedAt: startedAt,
        jobId:         dbJob.id,
        classTitle:    dbJob.class_title,
        outcome,
        status:        result.status,
        message:       result.message,
        minsUntilOpen,
        retryContext,
      });

    } catch (err) {
      console.error(`[preflight-loop] run:error — Job #${dbJob.id}:`, err.message);
      refreshReadiness({ jobId: dbJob.id, classTitle: dbJob.class_title, source: 'background' });

      // Timeout / unexpected error — treat as ambiguous, plan a retry.
      retryCount[dbJob.id] = (retryCount[dbJob.id] ?? 0) + 1;
      const errDecision = computeRetry({
        failureType:   'ambiguous',
        executionPhase: execPhase,
        attemptNumber:  retryCount[dbJob.id],
      });
      nextRetryAt[dbJob.id] = Date.now() + errDecision.retryDelayMs;
      console.log(
        `[preflight-loop] retry:plan — Job #${dbJob.id} ` +
        `failureType=ambiguous (error/timeout) phase=${execPhase} ` +
        `retryIn=${Math.round(errDecision.retryDelayMs / 1000)}s`
      );

      saveLoopState({
        lastCheckedAt: startedAt,
        jobId:         dbJob.id,
        classTitle:    dbJob.class_title,
        outcome:       'error',
        status:        'error',
        message:       err.message,
        minsUntilOpen,
        retryContext: {
          failureType:   'ambiguous',
          attemptNumber: retryCount[dbJob.id],
          retryDelayMs:  errDecision.retryDelayMs,
          phase:         execPhase,
          shouldRetry:   errDecision.shouldRetry,
          note:          'error/timeout — ambiguous retry',
        },
      });
    } finally {
      running = false;
    }

    // Process only one job per tick to avoid consecutive browser launches.
    break;
  }
}

module.exports = { runPreflightLoop, isRunning, loadLoopState };
