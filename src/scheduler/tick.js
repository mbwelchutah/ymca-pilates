// Shared one-tick execution logic.
// Used by both the continuous loop (run-scheduler-loop.js) and the
// "Run Scheduler Now" dashboard button (POST /run-scheduler-once).
//
// Does NOT check isSchedulerPaused() — callers decide whether to gate on it.

const { getAllJobs, setLastRun }    = require('../db/jobs');
const { getPhase, isPastClass }     = require('./booking-window');
const { runBookingJob }             = require('../bot/register-pilates');
const { getDryRun }                 = require('../bot/dry-run-state');
const { loadState, emitTickSkip }   = require('../bot/sniper-readiness');
// Stage 6 — feed booking-run timing into the run-speed learner.
const { recordRunSpeed }            = require('./timing-learner');
// Stage 10 (auth-truth-unification): session-failed gate now reads from the
// canonical source (auth-state.json via getCanonicalAuthTruth) instead of
// session-status.json (loadStatus).  lastFailureType (written by session-check.js)
// provides the timeout/auth_failed distinction previously only in session-status.json.
const { getCanonicalAuthTruth }      = require('../bot/auth-state');
// Stage 7 — update canonical confirmed-ready state after each booking run.
const { refreshConfirmedReadyState } = require('../bot/confirmed-ready');

// Fresh auth-block skip threshold: if the last run or session check recorded
// an auth failure within this window, skip warmup-phase attempts (they will
// fail for the same reason and waste a full browser launch).
const AUTH_BLOCK_STALE_MS         = 20 * 60 * 1000; // stale window for real auth failures
const AUTH_BLOCK_STALE_TIMEOUT_MS =  5 * 60 * 1000; // shorter window for transient timeouts

const COOLDOWN_MS        = 30 * 60 * 1000;  // cooldown for warmup phase
const COOLDOWN_SNIPER_MS =  90 * 1000;      // sniper: 90 s — window about to open, retry fast
const COOLDOWN_LATE_MS   =  60 * 1000;      // late: 60 s  — window already open, retry every minute
const ELIGIBLE_PHASES    = ['warmup', 'sniper', 'late'];

// Returns true if the ISO timestamp falls within the current UTC calendar week
// (Monday 00:00 UTC through Sunday 23:59 UTC).
function isThisWeek(isoStr) {
  if (!isoStr) return false;
  const successDate  = new Date(isoStr);
  const now          = new Date();
  const daysSinceMon = (now.getUTCDay() + 6) % 7;
  const weekStart    = new Date(now);
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
  return successDate >= weekStart;
}

function nowLabel() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
}

// In-memory concurrency guard shared across all callers in the same process.
const runningJobs = new Set();

// Tracks which past-class jobs we've already logged a "skipping past class"
// notice for in this process — keeps the scheduler log readable while still
// surfacing the condition once per job for traceability.
const pastClassLogged = new Set();

// Executes one scheduler tick: loads active jobs, filters by phase/cooldown/
// booked status, and runs eligible ones.
// Options:
//   onlyJobId    {number|null} — when set, only that job id is considered.
//   skipCooldown {boolean}     — Stage 10I: skip per-job cooldown check.
//     Only used by burst hot-retry attempts where the burst already verified
//     the action was available and the booking failed transiently.  Never set
//     for normal scheduler or manual invocations.
// Returns an array of result objects: { jobId, phase, status, message }.
async function runTick({ onlyJobId = null, skipCooldown = false } = {}) {
  const label = onlyJobId ? `job #${onlyJobId} only` : 'all jobs';
  console.log(`\n[${nowLabel()}] --- Scheduler tick (${label}) ---`);

  let jobs;
  try {
    jobs = getAllJobs().filter(j => j.is_active === 1);
    if (onlyJobId) jobs = jobs.filter(j => j.id === onlyJobId);
  } catch (err) {
    console.error('  ERROR loading jobs:', err.message);
    return [];
  }

  console.log(`  Active jobs in scope: ${jobs.length}`);
  const results = [];

  // Reconcile the past-class log gate against the *full* current job set
  // (active or not) so IDs for jobs that have been deleted, deactivated, or
  // advanced no longer accumulate in memory.  Without this, the Set could
  // grow unboundedly over a long-lived process.
  try {
    const currentIds = new Set(getAllJobs().map(j => j.id));
    for (const id of pastClassLogged) {
      if (!currentIds.has(id)) pastClassLogged.delete(id);
    }
  } catch (_) { /* best-effort cleanup; never block the tick */ }

  for (const dbJob of jobs) {
    const job = {
      id:          dbJob.id,
      classTitle:  dbJob.class_title,
      classTime:   dbJob.class_time,
      instructor:  dbJob.instructor  || null,
      dayOfWeek:   dbJob.day_of_week,
      targetDate:  dbJob.target_date  || null,
    };

    let phase;
    try {
      ({ phase } = getPhase(job));
    } catch (err) {
      console.error(`  Job #${dbJob.id}: ERROR computing phase — ${err.message}`);
      continue;
    }

    console.log(`  Job #${dbJob.id} (${dbJob.class_title} ${dbJob.day_of_week} ${dbJob.class_time}) — phase: ${phase}`);

    // Past one-off class: target_date + class_time is already in the past.
    // Skip the run loop entirely — no point launching the bot for a class that
    // has already happened.  The UI surfaces an "advance to next week" prompt
    // (see /api/state `passed` flag) so the user can roll the date forward.
    if (isPastClass(dbJob)) {
      if (!pastClassLogged.has(dbJob.id)) {
        console.log(`  => SKIPPING Job #${dbJob.id} — class has passed (${dbJob.target_date} ${dbJob.class_time}); waiting for user to advance or remove.`);
        pastClassLogged.add(dbJob.id);
      }
      results.push({ jobId: dbJob.id, phase, status: 'skipped', message: 'class has passed' });
      continue;
    }
    // If the job was past and is now future again (advanced by the user),
    // clear the one-shot log gate so a future past state will log again.
    pastClassLogged.delete(dbJob.id);

    if (!ELIGIBLE_PHASES.includes(phase)) {
      results.push({ jobId: dbJob.id, phase, status: 'skipped', message: `phase is ${phase}` });
      continue;
    }

    // Already-booked guard.
    if (dbJob.target_date) {
      const today = new Date().toISOString().slice(0, 10);
      // Primary: last_result is a success status AND the booking was made recently (within 7 days)
      // AND the target_date is still upcoming.  This covers the normal case where the booking
      // window opens 3 days before the class — last_success_at is April 10 but target_date is
      // April 13, so startsWith() would never match.
      const SUCCESS_STATUSES_GUARD = ['booked', 'success', 'waitlist', 'already_registered'];
      const isRecentSuccess = SUCCESS_STATUSES_GUARD.includes(dbJob.last_result) &&
                              dbJob.last_success_at &&
                              Date.now() - new Date(dbJob.last_success_at).getTime() < 7 * 24 * 60 * 60 * 1000;
      if (isRecentSuccess && dbJob.target_date >= today) {
        console.log(`  => SKIPPING Job #${dbJob.id} — already booked for target date ${dbJob.target_date} (booked ${dbJob.last_success_at.slice(0,10)})`);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: 'already booked (target date)' });
        continue;
      }
      // Fallback: legacy check where booking was made on the same day as the class
      if (dbJob.last_success_at && dbJob.last_success_at.startsWith(dbJob.target_date)) {
        console.log(`  => SKIPPING Job #${dbJob.id} — already booked for target date ${dbJob.target_date}`);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: 'already booked (target date)' });
        continue;
      }
    } else {
      if (isThisWeek(dbJob.last_success_at)) {
        console.log(`  => SKIPPING Job #${dbJob.id} — already booked this week`);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: 'already booked this week' });
        continue;
      }
    }

    // Concurrency guard.
    if (runningJobs.has(dbJob.id)) {
      console.log(`  => SKIPPING Job #${dbJob.id} — already running`);
      results.push({ jobId: dbJob.id, phase, status: 'skipped', message: 'already running' });
      continue;
    }

    // Cooldown guard.
    // Each phase gets a tailored cooldown so the bot can retry quickly when time
    // is critical without hammering the server in the non-urgent phases.
    //   warmup  — 30 min: window is distant; no need to hammer if session/class fails
    //   sniper  — 90 s:   window about to open; retry in < 2 min so the attempt fires
    //   late    — 60 s:   window already open; retry every minute during the booking window
    // Stage 10I: skipCooldown bypasses this check for burst hot-retry attempts.
    if (!skipCooldown && dbJob.last_run_at) {
      const msSinceRun  = Date.now() - new Date(dbJob.last_run_at).getTime();
      const cooldownFor = phase === 'late'   ? COOLDOWN_LATE_MS
                        : phase === 'sniper' ? COOLDOWN_SNIPER_MS
                        : COOLDOWN_MS;
      if (msSinceRun < cooldownFor) {
        const minAgo = Math.round(msSinceRun / 60000);
        const prevResult = dbJob.last_result || 'unknown';
        console.log(`  => SKIPPING Job #${dbJob.id} — ran recently (${minAgo} min ago, last result: ${prevResult}, cooldown: ${cooldownFor/60000} min)`);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: `cooldown (ran ${minAgo} min ago, last: ${prevResult})` });
        continue;
      }
    }

    // Classifier gate — warmup phase only.
    // If the schedule cache (populated by Playwright API interception) shows
    // the class is full AND that result is fresh, there is no point launching
    // a full browser session during warmup.  Sniper and late phases always
    // proceed — the booking window is open and the cache may be out of date.
    //
    // Freshness guard (Stage 1 — Warmup Freshness Guard pass):
    // An aging or stale "full" result is NOT authoritative enough to suppress
    // a warmup run.  The class may have opened since the cache was populated.
    // Only a fresh (< 30 min) "full" result may gate the warmup.
    //
    // Per-entry semantics (Stage 2 — Per-Entry Schedule-Cache Freshness pass):
    // cr.freshness is derived from entry.capturedAt (when that specific class row
    // was observed from the API), NOT from raw.savedAt (when the cache file was
    // last written).  A merge that refreshes savedAt without re-observing this
    // entry does NOT make it appear fresh here.
    if (phase === 'warmup') {
      try {
        const { classifyClass } = require('../classifier/classTruth');
        const cr = classifyClass({
          classTitle: dbJob.class_title,
          dayOfWeek:  dbJob.day_of_week,
          classTime:  dbJob.class_time,
          instructor: dbJob.instructor || null,
          targetDate: dbJob.target_date || null,
        });
        if (cr.state === 'full' && cr.freshness === 'fresh') {
          // [gate:skip_full_fresh] — fresh "full" truth is authoritative; suppress warmup.
          const reason = 'CLASSIFIER_FULL';
          const msg    = `Skipped warmup: schedule cache shows class is full — fresh (${cr.reason})`;
          console.log(
            `  => SKIPPING Job #${dbJob.id} [gate:skip_full_fresh] — ` +
            `state: full, freshness: fresh, conf: ${cr.confidence} — ${cr.reason}`
          );
          emitTickSkip(dbJob.id, reason, msg);
          results.push({ jobId: dbJob.id, phase, status: 'skipped', message: msg });
          continue;
        }
        if (cr.state === 'full') {
          // [gate:allow_full_<freshness>] — non-fresh "full" is not authoritative; run proceeds.
          const outcome = `gate:allow_full_${cr.freshness}`;
          console.log(
            `  Job #${dbJob.id} [${outcome}] — ` +
            `state: full, freshness: ${cr.freshness}, conf: ${cr.confidence} — ` +
            `warmup NOT suppressed (non-fresh full result is not authoritative)`
          );
        } else if (cr.state !== 'unknown') {
          // [gate:allow_<state>] — class is available or in a non-blocking state; run proceeds.
          const outcome = `gate:allow_${cr.state}`;
          console.log(
            `  Job #${dbJob.id} [${outcome}] — ` +
            `state: ${cr.state}, freshness: ${cr.freshness}, conf: ${cr.confidence}`
          );
        }
      } catch (classifyErr) {
        console.warn(`  Job #${dbJob.id}: classifier gate error — ${classifyErr.message}. Proceeding anyway.`);
      }
    }

    // Readiness gate — warmup phase only.
    // During warmup (30 min before the window), skip the run if we have
    // fresh evidence that auth is blocked: either the most recent sniper run
    // ended in SNIPER_BLOCKED_AUTH, or the last session check returned
    // valid: false.  In both cases, launching Chrome will fail in the same
    // place — skip and emit a SYSTEM event so the Run Events UI stays honest.
    // Sniper and late phases ALWAYS run: the booking window is open and a
    // missed retry may mean a lost booking.
    if (phase === 'warmup') {
      const sniperState   = loadState();
      const canonicalAuth = getCanonicalAuthTruth();

      let skipReason  = null;
      let skipMessage = null;

      // Use authBlockedAt (written only by real runs) rather than updatedAt
      // (written by every state save including skip events) so that emitting a
      // tick-skip event cannot refresh the gate's clock and extend suppression.
      // Fall back to updatedAt for older state files that predate authBlockedAt.
      if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH') {
        const refTime = sniperState.authBlockedAt || sniperState.updatedAt;
        if (refTime) {
          const age = Date.now() - new Date(refTime).getTime();
          if (age < AUTH_BLOCK_STALE_MS) {
            const minAgo = Math.round(age / 60000);
            skipReason  = 'SNIPER_BLOCKED_AUTH';
            skipMessage = `Skipped warmup: SNIPER_BLOCKED_AUTH from last run (${minAgo} min ago) — session still likely expired`;
          }
        }
      }

      // Stage 10: reads from canonical auth-state.json instead of session-status.json.
      // lastFailureType distinguishes transient timeouts (5-min gate) from real
      // credential failures (20-min gate), same logic as before.
      if (!skipReason && canonicalAuth.sessionValid === false) {
        const ageMs     = canonicalAuth.lastCheckedAt != null
          ? Date.now() - canonicalAuth.lastCheckedAt
          : null;
        const isTimeout = canonicalAuth.lastFailureType === 'timeout';
        const staleMs   = isTimeout ? AUTH_BLOCK_STALE_TIMEOUT_MS : AUTH_BLOCK_STALE_MS;
        if (ageMs != null && ageMs < staleMs) {
          const minAgo = Math.round(ageMs / 60000);
          skipReason  = 'SESSION_CHECK_FAILED';
          skipMessage = isTimeout
            ? `Skipped warmup: page-load timeout ${minAgo} min ago — will retry when stale (${Math.round((staleMs - ageMs) / 60000)} min)`
            : `Skipped warmup: session check failed ${minAgo} min ago — credentials likely invalid`;
        }
      }

      if (skipReason) {
        console.log(`  => SKIPPING Job #${dbJob.id} (warmup gate) — ${skipMessage}`);
        emitTickSkip(dbJob.id, skipReason, skipMessage);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: skipMessage });
        continue;
      }
    }

    runningJobs.add(dbJob.id);
    console.log(`  => RUNNING Job #${dbJob.id}...`);

    let lastResult = 'error';
    let lastErrMsg = null;
    try {
      const result = await runBookingJob(job, { dryRun: getDryRun() });
      lastResult = result.status;
      const NON_SUCCESS = ['error', 'found_not_open_yet', 'not_found'];
      if (NON_SUCCESS.includes(result.status)) lastErrMsg = result.message || null;
      console.log(`  => FINISHED Job #${dbJob.id}. status: ${result.status} | ${result.message}`);
      results.push({ jobId: dbJob.id, phase, status: result.status, message: result.message });
    } catch (err) {
      lastErrMsg = err.message || 'Uncaught exception';
      console.error(`  => ERROR Job #${dbJob.id}:`, err.message);
      results.push({ jobId: dbJob.id, phase, status: 'error', message: lastErrMsg });
    } finally {
      setLastRun(dbJob.id, lastResult, lastErrMsg);
      runningJobs.delete(dbJob.id);
      // Stage 7 — refresh confirmed-ready state so the UI and /api/confirmed-ready
      // reflect the outcome of this booking attempt without waiting for the next
      // scheduled preflight run.
      // Stage 6: source='tick' — post booking-attempt refresh, no new browser preflight.
      try {
        refreshConfirmedReadyState({
          classTitle: job.classTitle,
          dayOfWeek:  job.dayOfWeek,
          classTime:  job.classTime,
          instructor: job.instructor ?? null,
        }, { source: 'tick' });
      } catch (crErr) {
        console.warn(`  [confirmed-ready] post-tick refresh failed: ${crErr.message}`);
      }
      // Stage 6 — record run-speed observation from timing metrics written by
      // Stage 3.  loadState() reads the sniper-state.json updated moments ago
      // by runBookingJob() → recordTimingMetrics().  Booking runs are the most
      // time-critical path so their speed data is the most valuable for the
      // armed-offset learner.
      try {
        const freshState = loadState();
        const tm = freshState?.timingMetrics;
        if (tm) {
          recordRunSpeed(dbJob.id, {
            authMs:      tm.auth_phase_ms,
            pageLoadMs:  tm.run_start_to_page_ready,
            discoveryMs: tm.page_ready_to_class_found,
            classTitle:  job.classTitle,
          });
        }
      } catch (speedErr) {
        console.warn(`  [timing-learner] run-speed:error (tick) —`, speedErr.message);
      }
    }
  }

  return results;
}

module.exports = { runTick };
