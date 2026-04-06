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

const { getAllJobs }     = require('../db/jobs');
const { getPhase }       = require('./booking-window');
const { runBookingJob }  = require('../bot/register-pilates');
const { getDryRun }      = require('../bot/dry-run-state');
const { loadState }      = require('../bot/sniper-readiness');
const { loadStatus }     = require('../bot/session-check');
const { isLocked }       = require('../bot/auth-lock');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS        = 3  * 60 * 1000;  // min time between runs per job
const ACTIVE_HORIZON_MS      = 24 * 60 * 60 * 1000; // only run within 24 h of window
const AUTO_PREFLIGHT_OWNS_MS = 30 * 60 * 1000;  // auto-preflight owns inside 30 min
const AUTH_BLOCK_STALE_MS    = 20 * 60 * 1000;  // mirror of auto-preflight / tick.js

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'preflight-loop-state.json');

// ── In-memory state ───────────────────────────────────────────────────────────

let running = false;

// Per-job timestamp of the last background run (epoch ms).
// Survives within a server session; resets on restart (acceptable — first run
// after restart will find lastCheckedAt in STATE_FILE for display purposes).
const lastRunAt = {};

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

// ── Public helpers ────────────────────────────────────────────────────────────

function isRunning() { return running; }

// ── Main entry point ──────────────────────────────────────────────────────────
// Call once per scheduler tick (every 60 s).
// isActive: true while a real booking run is open — stay out of the way.

async function runPreflightLoop({ isActive = false } = {}) {
  if (running) {
    console.log('[preflight-loop] Skipping tick — loop already in progress.');
    return;
  }
  if (isActive) {
    console.log('[preflight-loop] Skipping tick — booking job active.');
    return;
  }

  let jobs;
  try {
    jobs = getAllJobs().filter(j => j.is_active === 1);
  } catch (err) {
    console.error('[preflight-loop] Could not load jobs:', err.message);
    return;
  }
  if (jobs.length === 0) return;

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

    // ── Interval gate ───────────────────────────────────────────────────────
    const last = lastRunAt[dbJob.id] ?? 0;
    if (Date.now() - last < MIN_INTERVAL_MS) continue;

    // ── Auth-block gate ─────────────────────────────────────────────────────
    if (isLocked()) {
      console.log(`[preflight-loop] Job #${dbJob.id} skipped — auth lock held (concurrent operation in progress).`);
      continue;
    }

    if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH') {
      const refTime = sniperState.authBlockedAt || sniperState.updatedAt;
      if (refTime) {
        const age = Date.now() - new Date(refTime).getTime();
        if (age < AUTH_BLOCK_STALE_MS) {
          const minAgo = Math.round(age / 60000);
          console.log(`[preflight-loop] Job #${dbJob.id} skipped — SNIPER_BLOCKED_AUTH from ${minAgo} min ago.`);
          continue;
        }
      }
    }

    if (sessionStatus?.valid === false && sessionStatus.checkedAt) {
      const age = Date.now() - new Date(sessionStatus.checkedAt).getTime();
      if (age < AUTH_BLOCK_STALE_MS) {
        const minAgo = Math.round(age / 60000);
        console.log(`[preflight-loop] Job #${dbJob.id} skipped — session check failed ${minAgo} min ago.`);
        continue;
      }
    }

    // ── Run ─────────────────────────────────────────────────────────────────
    running = true;
    lastRunAt[dbJob.id] = Date.now();

    const minsUntilOpen = Math.round(msUntilOpen / 60000);
    console.log(
      `[preflight-loop] Starting background preflight — ` +
      `Job #${dbJob.id} (${dbJob.class_title}), ${minsUntilOpen} min until window opens.`
    );

    const startedAt = new Date().toISOString();
    try {
      const result = await runBookingJob({
        id:          dbJob.id,
        classTitle:  dbJob.class_title,
        classTime:   dbJob.class_time,
        instructor:  dbJob.instructor  || null,
        dayOfWeek:   dbJob.day_of_week,
        targetDate:  dbJob.target_date || null,
        maxAttempts: 1,
      }, { preflightOnly: true, dryRun: getDryRun() });

      const outcome = result.status === 'success' ? 'pass' : 'fail';
      console.log(`[preflight-loop] Done — Job #${dbJob.id} ${outcome}: ${result.message}`);

      saveLoopState({
        lastCheckedAt: startedAt,
        jobId:         dbJob.id,
        classTitle:    dbJob.class_title,
        outcome,
        status:        result.status,
        message:       result.message,
        minsUntilOpen,
      });

    } catch (err) {
      console.error(`[preflight-loop] Error — Job #${dbJob.id}:`, err.message);
      saveLoopState({
        lastCheckedAt: startedAt,
        jobId:         dbJob.id,
        classTitle:    dbJob.class_title,
        outcome:       'error',
        status:        'error',
        message:       err.message,
        minsUntilOpen,
      });
    } finally {
      running = false;
    }

    // Process only one job per tick to avoid consecutive browser launches.
    break;
  }
}

module.exports = { runPreflightLoop, isRunning, loadLoopState };
