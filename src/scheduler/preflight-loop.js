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
const { loadState, updateLastSuccessfulPreflightAt } = require('../bot/sniper-readiness');
// Stage 10 (auth-truth-unification): loadStatus (session-status.json) replaced by
// getCanonicalAuthTruth for session-failed gate. lastFailureType from auth-state.json
// now provides the timeout/auth_failed distinction.
const { isLocked }                          = require('../bot/auth-lock');
const { getAuthState, getCanonicalAuthTruth } = require('../bot/auth-state');
const { refreshReadiness }     = require('../bot/readiness-state');
const { computeExecutionTiming, WARMUP_OFFSET_MS, ARMED_OFFSET_MS } = require('./execution-timing');
const { classifyFailure, computeRetry } = require('./retry-strategy');
const { setEscalation, clearEscalation } = require('./escalation');
// Stage 10F — Learned timing adjustments.
// Stage 5: run-speed observations extend this with recordRunSpeed / getLearnedRunSpeed.
const { recordObservation, getLearnedOffsets, recordRunSpeed, getLearnedRunSpeed } = require('./timing-learner');
// Stage 10G — Direct burst-to-booking handoff (bypasses up-to-60s tick delay).
const { triggerBookingFromBurst } = require('./booking-bridge');
// Stage 4 (freshness) — persist canonical readiness state after every preflight.
const { refreshConfirmedReadyState } = require('../bot/confirmed-ready');
// Stage 5 (live-truth–driven booking timing) — small, bounded urgency hints
// derived from the live FW API verdict.  Never hard-skips browser launches;
// only nudges the preempt buffer and next-burst delay.
const liveTruth = require('../classifier/liveTruth');

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS        = 3  * 60 * 1000;  // min time between runs per job
const ACTIVE_HORIZON_MS      = 24 * 60 * 60 * 1000; // only run within 24 h of window
const AUTO_PREFLIGHT_OWNS_MS = 30 * 60 * 1000;  // auto-preflight owns inside 30 min
const AUTH_BLOCK_STALE_MS         = 20 * 60 * 1000; // stale window for real auth failures
const AUTH_BLOCK_STALE_TIMEOUT_MS =  5 * 60 * 1000; // shorter window for transient timeouts
const PREFLIGHT_TIMEOUT_MS   = 90 * 1000;        // max wall-time for one preflight run

// Stage 10C — Micro-burst constants.
// The burst activates when a job enters execution `warmup` or `armed` phase
// (inside the AUTO_PREFLIGHT_OWNS zone — within 3 min of opensAt).  It
// fires short-interval preflight checks independently of the 60 s scheduler
// tick so the system detects action availability within seconds, not minutes.
const MAX_BURST_RUNS       = 8;              // hard cap on consecutive burst checks
const BURST_WINDOW_AFTER_MS = 90 * 1000;    // stop bursting 90 s after opensAt

// Stage 10I — Hot-retry constants.
// After a burst-triggered booking fails transiently (found_not_open_yet / error),
// schedule up to MAX_HOT_RETRIES rapid re-attempts before giving up.
const MAX_HOT_RETRIES    = 3;              // max re-attempts after burst-handoff failure
const HOT_RETRY_DELAY_MS = 5_000;         // 5 s between hot-retry attempts

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

// Stage 10C — Micro-burst state (in-memory, per job).
// burstTimers[jobId] : active setTimeout handle for the next burst check.
// burstCount[jobId]  : number of burst checks fired this activation cycle.
const burstTimers = {};
const burstCount  = {};

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

// ── Stage 10C — Micro-burst helpers ──────────────────────────────────────────
//
// The burst activates when a job's execution phase is `warmup` or `armed`
// (within 3 min of opensAt).  It fires a short-interval self-scheduling loop
// that calls runBookingJob({preflightOnly:true}) every ~20 s so the system
// detects action availability within seconds rather than waiting for the next
// 60 s scheduler tick.
//
// Safety bounds:
//   - max MAX_BURST_RUNS consecutive checks per activation cycle
//   - stops automatically BURST_WINDOW_AFTER_MS (90 s) after opensAt
//   - stops when execution phase exits warmup/armed (opensAt passed)
//   - guards: running flag + isLocked() prevent overlap with main loop or auth

function resetBurst(jobId) {
  if (burstTimers[jobId]) {
    clearTimeout(burstTimers[jobId]);
    delete burstTimers[jobId];
  }
  burstCount[jobId] = 0;
}

function scheduleBurst(dbJob, delayMs) {
  // Cancel any pending timer for this job before setting a new one.
  if (burstTimers[dbJob.id]) {
    clearTimeout(burstTimers[dbJob.id]);
    delete burstTimers[dbJob.id];
  }

  if ((burstCount[dbJob.id] ?? 0) >= MAX_BURST_RUNS) {
    console.log(`[preflight-loop] burst:limit — Job #${dbJob.id} reached ${MAX_BURST_RUNS} burst checks.`);
    resetBurst(dbJob.id);
    return;
  }

  console.log(`[preflight-loop] burst:schedule — Job #${dbJob.id} next check in ${Math.round(delayMs / 1000)}s.`);
  burstTimers[dbJob.id] = setTimeout(() => {
    delete burstTimers[dbJob.id];
    runBurstCheck(dbJob).catch(e =>
      console.error(`[preflight-loop] burst:error — Job #${dbJob.id}:`, e.message)
    );
  }, delayMs);
}

async function runBurstCheck(dbJob) {
  // ── Guards ─────────────────────────────────────────────────────────────────
  if (running) {
    console.log(`[preflight-loop] burst:skip — Job #${dbJob.id} loop busy, will retry next activation.`);
    return;
  }
  if (isLocked()) {
    console.log(`[preflight-loop] burst:skip — Job #${dbJob.id} auth lock held.`);
    return;
  }

  // ── Window check ───────────────────────────────────────────────────────────
  // Stage 10F — apply any learned timing adjustments before computing phase.
  const burstLearned = getLearnedOffsets(dbJob.id, { WARMUP_OFFSET_MS, ARMED_OFFSET_MS });
  let execTiming;
  try {
    execTiming = computeExecutionTiming(dbJob, {
      warmupOffsetOverrideMs: burstLearned?.adjustedWarmupOffsetMs ?? null,
      armedOffsetOverrideMs:  burstLearned?.adjustedArmedOffsetMs  ?? null,
    });
  } catch (_) { return; }

  const opensAtMs    = new Date(execTiming.opensAt).getTime();
  const pastBurstEnd = Date.now() > opensAtMs + BURST_WINDOW_AFTER_MS;

  if (pastBurstEnd) {
    console.log(`[preflight-loop] burst:expired — Job #${dbJob.id} past burst window; stopping.`);
    resetBurst(dbJob.id);
    return;
  }

  // Stop burst once the window has opened and tick.js takes over.
  if (execTiming.msUntilOpen < 0) {
    console.log(`[preflight-loop] burst:yield — Job #${dbJob.id} opensAt passed; yielding to scheduler.`);
    resetBurst(dbJob.id);
    return;
  }

  // ── Run preflight ──────────────────────────────────────────────────────────
  running = true;
  burstCount[dbJob.id] = (burstCount[dbJob.id] ?? 0) + 1;
  const runNum = burstCount[dbJob.id];

  console.log(
    `[preflight-loop] burst:check — Job #${dbJob.id} ` +
    `run ${runNum}/${MAX_BURST_RUNS} ` +
    `phase:${execTiming.phase} ` +
    `${Math.round(execTiming.msUntilOpen / 1000)}s until open.`
  );

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
      `Job #${dbJob.id} burst`
    );

    // Stage 3 (write-order fix) — confirmed-ready must be written before readiness
    // so that computeReadiness()'s lazy-loaded loadConfirmedReadyState() reads the
    // current run's classTruth freshness, not the previous run's file.
    // Stage 6: source='browser' — a full Playwright burst run just completed.
    refreshConfirmedReadyState({
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      instructor: dbJob.instructor  || null,
      dayOfWeek:  dbJob.day_of_week,
      targetDate: dbJob.target_date || null,
    }, { source: 'browser' });
    refreshReadiness({ jobId: dbJob.id, classTitle: dbJob.class_title, source: 'background' });

    // Stage 5: Record run-speed observation from the timing metrics written by
    // Stage 3.  loadState() re-reads sniper-state.json, which was just updated
    // by runBookingJob() → recordTimingMetrics().
    try {
      const freshState = loadState();
      const tm = freshState?.timingMetrics;
      if (tm) {
        recordRunSpeed(dbJob.id, {
          authMs:      tm.auth_phase_ms,
          pageLoadMs:  tm.run_start_to_page_ready,
          discoveryMs: tm.page_ready_to_class_found,
          classTitle:  dbJob.class_title,
        });
      }
    } catch (speedErr) {
      console.warn('[timing-learner] run-speed:error —', speedErr.message);
    }

    const failureType = classifyFailure(result);

    if (!failureType) {
      // Stage 10G — Burst-to-booking direct handoff.
      // The action is available right now.  Instead of resetting and waiting up
      // to 60 s for the scheduler tick to notice, immediately fire a full
      // booking run via the bridge (same runTick() path, all existing guards
      // applied: booked-this-week, concurrency, cooldown, auth-block).
      console.log(
        `[preflight-loop] burst:ready — Job #${dbJob.id} action available ` +
        `(${result.status}); handing off to booking run immediately.`
      );
      resetBurst(dbJob.id);
      retryCount[dbJob.id]  = 0;
      nextRetryAt[dbJob.id] = Date.now() + MIN_INTERVAL_MS;
      // Stage 10D — clear any pending escalation on success.
      clearEscalation(dbJob.id);
      // Task #57 — record successful automated preflight for auto-hide logic.
      updateLastSuccessfulPreflightAt();
      // Stage 10F — record when the action became available relative to opensAt.
      if (execTiming?.opensAt) {
        recordObservation(dbJob.id, {
          expectedOpensAtMs: new Date(execTiming.opensAt).getTime(),
          observedReadyAtMs: Date.now(),
          classTitle:        dbJob.class_title ?? null,
        });
      }
      // Fire the booking.  triggerBookingFromBurst is fire-and-forget; errors
      // are logged inside the bridge.  running=false (set in finally below)
      // BEFORE this is called so tick.js's runningJobs guard is not blocked.
      // We explicitly do NOT await this — the finally block must release
      // `running` before the booking's browser launch starts.
      //
      // Stage 10I — pass opensAtMs + onRetry so a transient failure at window
      // open triggers a hot retry within HOT_RETRY_DELAY_MS instead of waiting
      // for the 5-min tick cooldown.
      const handoffOpensAtMs = execTiming?.opensAt
        ? new Date(execTiming.opensAt).getTime()
        : null;
      triggerBookingFromBurst(dbJob.id, {
        onRetry: (status) => scheduleHotRetry(dbJob, handoffOpensAtMs, 1, status),
      }).catch(e =>
        console.error(`[preflight-loop] burst:handoff-error — Job #${dbJob.id}:`, e.message)
      );
    } else {
      // Not available yet — schedule next burst if within limits.
      const decision = computeRetry({
        failureType,
        executionPhase: execTiming.phase,
        attemptNumber:  runNum,
      });

      // Stage 9 — Preemptive booking launch.
      //
      // Problem: the burst fires preflight-only checks (HTTP + browser navigate)
      // every ~20 s.  Each check takes ~30 s to complete.  When the last burst
      // returns "not open yet" at T-37 s and schedules the next check in 15 s,
      // that check fires at T-22 s but ACTION_READY is only detectable at T=0.
      // By then there are only 22 s left — but the bot needs ~47 s to reach the
      // modal.  The booking run inevitably arrives late.
      //
      // Fix: when a preflight confirms the class is found and the modal is
      // reachable (found_not_open_yet), and the remaining time is ≤ the bot's
      // measured lead time + a small buffer, fire the booking run NOW.  The
      // booking run's own poll loop waits for the Register button — far better
      // than a burst that would arrive after window-open.
      //
      // Stage 9 guard used getLearnedRunSpeed() != null — which silently disabled
      // preemptive launch for the first MIN_OBS (3) runs before the learner had
      // data.  Stage 10 replaces the null-gate with a conservative cold-start
      // default so even run #1 benefits from preemptive launch.
      //
      // DEFAULT_PREEMPT_MS (60 s) is chosen to be:
      //   • above the typical learned neededLeadTimeMs (~50 s = median_total + 15 s)
      //   • within the learner's [MIN_LEAD_TIME_MS=20 s, MAX_LEAD_TIME_MS=180 s] range
      //   • conservative enough that arriving 10 s early at the modal is fine
      //     (bot polls cheaply for the Register button until window opens)
      const DEFAULT_PREEMPT_MS = 60_000;  // cold-start fallback before MIN_OBS runs
      const _learnedSpeed   = getLearnedRunSpeed(dbJob.id);
      const _preemptLeadMs  = _learnedSpeed?.neededLeadTimeMs ?? DEFAULT_PREEMPT_MS;
      const _preemptSource  = _learnedSpeed ? 'learned' : 'default';
      const PREEMPT_BUFFER_MS = 5_000;  // 5 s safety buffer on top of lead time

      // Stage 5 — nudge the preempt buffer based on fresh live truth.
      // Fresh `open`/`waitlist` widens the buffer (preempt slightly earlier);
      // fresh `full`/`cancelled` shrinks it (avoids wasteful early launches);
      // unknown/stale leaves it unchanged.  Final buffer is clamped ≥ 0 so the
      // preempt threshold can never go below the bare lead time.
      const _urgency = liveTruth.getUrgencyHints(
        liveTruth.getVerdict(liveTruth.getCached(dbJob.id))
      );
      const _effectiveBufferMs = Math.max(0, PREEMPT_BUFFER_MS + _urgency.preemptBufferDeltaMs);
      if (_urgency.source === 'live-truth' && _urgency.preemptBufferDeltaMs !== 0) {
        console.log(
          `[preflight-loop] burst:urgency — Job #${dbJob.id} ` +
          `${_urgency.reason} → preempt buffer ` +
          `${PREEMPT_BUFFER_MS}ms ${_urgency.preemptBufferDeltaMs >= 0 ? '+' : ''}` +
          `${_urgency.preemptBufferDeltaMs}ms = ${_effectiveBufferMs}ms.`
        );
      }

      if (
        failureType === 'action_not_open'   &&
        result.status === 'found_not_open_yet' &&
        execTiming.msUntilOpen > 0          &&
        execTiming.msUntilOpen <= _preemptLeadMs + _effectiveBufferMs
      ) {
        const _preemptOpensAtMs = execTiming?.opensAt
          ? new Date(execTiming.opensAt).getTime()
          : null;
        console.log(
          `[preflight-loop] burst:preempt — Job #${dbJob.id} ` +
          `${Math.round(execTiming.msUntilOpen / 1000)}s until open, ` +
          `neededLead=${Math.round(_preemptLeadMs / 1000)}s (${_preemptSource}); ` +
          `launching booking run now so bot arrives at modal before window opens.`
        );
        resetBurst(dbJob.id);
        retryCount[dbJob.id]  = 0;
        nextRetryAt[dbJob.id] = Date.now() + MIN_INTERVAL_MS;
        triggerBookingFromBurst(dbJob.id, {
          onRetry: (status) => scheduleHotRetry(dbJob, _preemptOpensAtMs, 1, status),
        }).catch(e =>
          console.error(`[preflight-loop] burst:preempt-error — Job #${dbJob.id}:`, e.message)
        );
      // Stage 10D — escalate on click_failed; do not burst-retry.
      } else if (failureType === 'click_failed') {
        setEscalation(dbJob.id, {
          classTitle:     dbJob.class_title,
          classTime:      dbJob.class_time  ?? null,
          reason:         'click_failed',
          executionPhase: execTiming.phase,
          attemptNumber:  runNum,
        });
        console.log(`[preflight-loop] burst:escalate — Job #${dbJob.id} click_failed; stopping burst.`);
        resetBurst(dbJob.id);
      } else if (decision.shouldRetry && runNum < MAX_BURST_RUNS) {
        // Stage 5 — apply burst-delay multiplier from live truth.
        // Fresh `open`/`waitlist` shortens the delay (poll faster);
        // fresh `full`/`cancelled` lengthens it (less wasted work);
        // unknown/stale leaves it at decision.retryDelayMs (×1.0).
        // Final delay is clamped to [5_000, 60_000] so the cadence can never
        // become unsafe (too aggressive) or effectively dormant (too slow).
        let _adjustedDelayMs = Math.max(
          5_000,
          Math.min(60_000, Math.round(decision.retryDelayMs * _urgency.burstDelayMultiplier))
        );
        if (_urgency.source === 'live-truth' && _adjustedDelayMs !== decision.retryDelayMs) {
          console.log(
            `[preflight-loop] burst:cadence — Job #${dbJob.id} ` +
            `${_urgency.reason} → next burst delay ` +
            `${decision.retryDelayMs}ms × ${_urgency.burstDelayMultiplier} = ${_adjustedDelayMs}ms.`
          );
        }

        // Stage 6 — open-transition acceleration.
        //
        // If liveTruth observed a non-bookable→bookable flip in the last
        // 30 s, override the next burst delay to the minimum safe floor
        // (ACCELERATED_BURST_MS) so the next preflight fires ASAP and the
        // newly-available class can be claimed before someone else takes it.
        //
        // Storm-protection guarantees:
        //   • consumeOpenTransition is one-shot per real flip — repeated
        //     "still open" refreshes do NOT re-arm.
        //   • We only OVERRIDE the already-planned burst delay; we do NOT
        //     schedule an extra burst.  scheduleBurst() also cancels any
        //     existing timer before setting the new one, so duplicate
        //     launches are structurally impossible.
        //   • MAX_BURST_RUNS / shouldRetry gating still wins — if we're
        //     out of attempts, transition has zero effect.
        //   • Floor of 5 s prevents the override from creating an unsafe
        //     tight loop.
        const ACCELERATED_BURST_MS = 5_000;
        if (
          _adjustedDelayMs > ACCELERATED_BURST_MS &&
          liveTruth.consumeOpenTransition(dbJob.id)
        ) {
          console.log(
            `[preflight-loop] burst:accelerate — Job #${dbJob.id} ` +
            `liveTruth flipped to OPEN; ` +
            `shortening next burst ${_adjustedDelayMs}ms → ${ACCELERATED_BURST_MS}ms (one-shot).`
          );
          _adjustedDelayMs = ACCELERATED_BURST_MS;
        }

        scheduleBurst(dbJob, _adjustedDelayMs);
      } else {
        console.log(`[preflight-loop] burst:stop — Job #${dbJob.id} max runs or shouldRetry=false.`);
        resetBurst(dbJob.id);
      }
    }

  } catch (err) {
    console.error(`[preflight-loop] burst:error — Job #${dbJob.id}:`, err.message);
    // Don't retry on error — let the next scheduler tick try.
    resetBurst(dbJob.id);
  } finally {
    running = false;
  }
}

// ── Stage 10I — Hot-retry after burst-handoff failure ─────────────────────────
//
// When the burst-triggered booking attempt returns a retryable status
// (found_not_open_yet / error), the bridge invokes this instead of waiting
// for the 5-min tick cooldown.  Schedules up to MAX_HOT_RETRIES rapid
// re-attempts (each with skipCooldown=true) within the BURST_WINDOW_AFTER_MS
// window.  Self-terminates when the window closes, the cap is reached, or
// a non-retryable outcome is returned.

/**
 * Schedule the next hot-retry for a burst-triggered booking that just failed.
 *
 * @param {object} dbJob        — the raw job row (id, class_title, …)
 * @param {number|null} opensAtMs — epoch ms of the booking window open time
 * @param {number} attemptNum   — 1-based attempt counter
 * @param {string} reason       — the status that triggered this retry
 */
function scheduleHotRetry(dbJob, opensAtMs, attemptNum, reason) {
  if (attemptNum > MAX_HOT_RETRIES) {
    console.log(
      `[preflight-loop] hot-retry:cap — Job #${dbJob.id} reached max ` +
      `${MAX_HOT_RETRIES} hot retries (last reason: "${reason}"); giving up.`
    );
    return;
  }

  if (opensAtMs && Date.now() > opensAtMs + BURST_WINDOW_AFTER_MS) {
    console.log(
      `[preflight-loop] hot-retry:expired — Job #${dbJob.id} burst window ` +
      `closed before attempt ${attemptNum} (reason: "${reason}").`
    );
    return;
  }

  console.log(
    `[preflight-loop] hot-retry:schedule — Job #${dbJob.id} ` +
    `attempt ${attemptNum}/${MAX_HOT_RETRIES} after "${reason}" ` +
    `in ${HOT_RETRY_DELAY_MS / 1000}s.`
  );

  setTimeout(() => {
    // Re-check window expiry at fire time (delay may have crossed the boundary).
    if (opensAtMs && Date.now() > opensAtMs + BURST_WINDOW_AFTER_MS) {
      console.log(
        `[preflight-loop] hot-retry:expired — Job #${dbJob.id} burst window ` +
        `closed at fire time for attempt ${attemptNum}.`
      );
      return;
    }

    // Re-use the bridge with skipCooldown=true so the 5-min tick cooldown is
    // bypassed.  A new onRetry callback chains the next attempt if needed.
    triggerBookingFromBurst(dbJob.id, {
      skipCooldown: true,
      onRetry: (nextStatus) =>
        scheduleHotRetry(dbJob, opensAtMs, attemptNum + 1, nextStatus),
    }).catch(e =>
      console.error(
        `[preflight-loop] hot-retry:error — Job #${dbJob.id} attempt ${attemptNum}:`,
        e.message
      )
    );
  }, HOT_RETRY_DELAY_MS);
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

  // Stage 10C — Burst activation scan.
  // Jobs in the warmup or armed execution phase (within 3 min of opensAt) are
  // outside the main loop's AUTO_PREFLIGHT_OWNS_MS gate but still need frequent
  // preflight checks.  If no burst is already active for a job in that window,
  // kick one off here.  The burst then self-schedules independently of the tick.
  if (!running && !isLocked()) {
    for (const dbJob of jobs) {
      if (burstTimers[dbJob.id]) continue; // burst already active
      // Stage 10F — apply learned offsets so burst activates at the adjusted phase boundary.
      const scanLearned = getLearnedOffsets(dbJob.id, { WARMUP_OFFSET_MS, ARMED_OFFSET_MS });
      // Stage 5 — factor in measured run-speed so the armed offset is wide enough
      // for the bot to finish page load before the booking window opens.
      // neededLeadTimeMs = median(auth + page-load + discovery) + 15 s buffer.
      // If the bot consistently takes 32 s to be ready and ARMED_OFFSET is 45 s,
      // margin is fine.  But if the site is slow at window open (e.g. 40 s page
      // load), the bot would arrive late.  This extension prevents that.
      const learnedSpeed    = getLearnedRunSpeed(dbJob.id);
      const baseArmedMs     = scanLearned?.adjustedArmedOffsetMs ?? ARMED_OFFSET_MS;
      const effectiveArmedMs = learnedSpeed
        ? Math.max(baseArmedMs, learnedSpeed.neededLeadTimeMs)
        : baseArmedMs;
      if (learnedSpeed && effectiveArmedMs > baseArmedMs) {
        console.log(
          `[timing-learner] run-speed:extend — Job #${dbJob.id} ` +
          `armedOffset ${Math.round(baseArmedMs / 1000)}s → ` +
          `${Math.round(effectiveArmedMs / 1000)}s ` +
          `(median lead ${Math.round(learnedSpeed.medianTotalMs / 1000)}s + 15s buffer; ` +
          `n=${learnedSpeed.observationCount}).`
        );
      }
      let et;
      try {
        et = computeExecutionTiming(dbJob, {
          warmupOffsetOverrideMs: scanLearned?.adjustedWarmupOffsetMs ?? null,
          armedOffsetOverrideMs:  effectiveArmedMs,
        });
      } catch (_) { continue; }
      if (et.phase === 'warmup' || et.phase === 'armed') {
        console.log(
          `[preflight-loop] burst:activate — Job #${dbJob.id} ` +
          `entering execution phase "${et.phase}" ` +
          `(${Math.round(et.msUntilOpen / 1000)}s until open).`
        );
        burstCount[dbJob.id] = 0;
        runBurstCheck(dbJob).catch(e =>
          console.error(`[preflight-loop] burst:error — Job #${dbJob.id}:`, e.message)
        );
      }
    }
  }

  // Load auth state once — shared across all jobs this tick.
  // Stage 10: canonical source replaces loadStatus() (session-status.json).
  const sniperState   = loadState();
  const canonicalAuth = getCanonicalAuthTruth();

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

    // Primary: AuthState singleton — authoritative source of truth
    const authState = getAuthState();
    if (authState.status === 'signed_out') {
      console.log(`[preflight-loop] skip:signed-out — Job #${dbJob.id} (AuthState is signed_out; login required).`);
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

    // Stage 10: gate now reads from canonical auth-state.json instead of
    // session-status.json.  lastCheckedAt (ms epoch) replaces the ISO string parse.
    if (canonicalAuth.sessionValid === false) {
      const ageMs   = canonicalAuth.lastCheckedAt != null
        ? Date.now() - canonicalAuth.lastCheckedAt
        : null;
      // Timeouts (YMCA site slow) use a shorter 5-min window; real auth failures
      // (wrong credentials, account locked) block for the full 20 min.
      const isTimeout = canonicalAuth.lastFailureType === 'timeout';
      const staleMs   = isTimeout ? AUTH_BLOCK_STALE_TIMEOUT_MS : AUTH_BLOCK_STALE_MS;
      if (ageMs != null && ageMs < staleMs) {
        const minAgo  = Math.round(ageMs / 60000);
        const reason  = isTimeout ? 'page-load timeout' : 'auth failure';
        console.log(`[preflight-loop] skip:session-failed — Job #${dbJob.id} (${reason} ${minAgo} min ago, resumes in ${Math.round((staleMs - ageMs) / 60000)} min).`);
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

      const outcome = (result.status === 'success' || result.status === 'booked' || result.status === 'found_not_open_yet' || result.status === 'waitlist_only') ? 'pass' : 'fail';
      console.log(`[preflight-loop] run:result — Job #${dbJob.id} ${outcome}: ${result.message}`);

      // Stage 3 (write-order fix) — confirmed-ready before readiness (same cycle truth).
      // Stage 6: source='browser' — a full Playwright preflight run just completed.
      refreshConfirmedReadyState({
        classTitle: dbJob.class_title,
        classTime:  dbJob.class_time,
        instructor: dbJob.instructor  || null,
        dayOfWeek:  dbJob.day_of_week,
        targetDate: dbJob.target_date || null,
      }, { source: 'browser' });
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

        // Stage 10D — escalate on click_failed (blind retry suppressed; user must verify).
        if (failureType === 'click_failed') {
          setEscalation(dbJob.id, {
            classTitle:     dbJob.class_title,
            classTime:      dbJob.class_time  ?? null,
            reason:         'click_failed',
            executionPhase: execPhase,
            attemptNumber:  retryCount[dbJob.id],
          });
        }
      } else {
        // Success: reset consecutive failure count; next run at normal cadence.
        retryCount[dbJob.id]  = 0;
        nextRetryAt[dbJob.id] = Date.now() + MIN_INTERVAL_MS;
        // Stage 10D — clear any pending escalation now that the action succeeded.
        clearEscalation(dbJob.id);
        // Task #57 — record successful automated preflight for auto-hide logic.
        updateLastSuccessfulPreflightAt();
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
      // Stage 3 (write-order fix) — confirmed-ready before readiness (same cycle truth).
      // Stage 6: source='browser' — browser run attempted (even though it errored).
      refreshConfirmedReadyState({
        classTitle: dbJob.class_title,
        classTime:  dbJob.class_time,
        instructor: dbJob.instructor  || null,
        dayOfWeek:  dbJob.day_of_week,
        targetDate: dbJob.target_date || null,
      }, { source: 'browser' });
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
