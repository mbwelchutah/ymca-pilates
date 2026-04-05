// Shared one-tick execution logic.
// Used by both the continuous loop (run-scheduler-loop.js) and the
// "Run Scheduler Now" dashboard button (POST /run-scheduler-once).
//
// Does NOT check isSchedulerPaused() — callers decide whether to gate on it.

const { getAllJobs, setLastRun } = require('../db/jobs');
const { getPhase }               = require('./booking-window');
const { runBookingJob }          = require('../bot/register-pilates');
const { getDryRun }              = require('../bot/dry-run-state');
const { loadState, emitTickSkip } = require('../bot/sniper-readiness');
const { loadStatus }             = require('../bot/session-check');

// Fresh auth-block skip threshold: if the last run or session check recorded
// an auth failure within this window, skip warmup-phase attempts (they will
// fail for the same reason and waste a full browser launch).
const AUTH_BLOCK_STALE_MS = 20 * 60 * 1000; // 20 minutes

const COOLDOWN_MS        = 30 * 60 * 1000;  // cooldown for warmup phase
const COOLDOWN_HOT_MS    =  5 * 60 * 1000;  // shorter cooldown for sniper/late — must retry fast
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

// Executes one scheduler tick: loads active jobs, filters by phase/cooldown/
// booked status, and runs eligible ones.
// Options:
//   onlyJobId {number|null} — when set, only that job id is considered.
// Returns an array of result objects: { jobId, phase, status, message }.
async function runTick({ onlyJobId = null } = {}) {
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

    if (!ELIGIBLE_PHASES.includes(phase)) {
      results.push({ jobId: dbJob.id, phase, status: 'skipped', message: `phase is ${phase}` });
      continue;
    }

    // Already-booked guard.
    if (dbJob.target_date) {
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
    // Sniper and late phases get a short 5-min cooldown so the bot can retry quickly
    // after a warmup miss (warmup runs 10 min before the window opens; if it fails because
    // the class isn't listed yet, sniper/late must retry within minutes of opening).
    if (dbJob.last_run_at) {
      const msSinceRun  = Date.now() - new Date(dbJob.last_run_at).getTime();
      const cooldownFor = (phase === 'sniper' || phase === 'late') ? COOLDOWN_HOT_MS : COOLDOWN_MS;
      if (msSinceRun < cooldownFor) {
        const minAgo = Math.round(msSinceRun / 60000);
        const prevResult = dbJob.last_result || 'unknown';
        console.log(`  => SKIPPING Job #${dbJob.id} — ran recently (${minAgo} min ago, last result: ${prevResult}, cooldown: ${cooldownFor/60000} min)`);
        results.push({ jobId: dbJob.id, phase, status: 'skipped', message: `cooldown (ran ${minAgo} min ago, last: ${prevResult})` });
        continue;
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
      const sniperState    = loadState();
      const sessionStatus  = loadStatus();

      let skipReason  = null;
      let skipMessage = null;

      if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH' && sniperState.updatedAt) {
        const age = Date.now() - new Date(sniperState.updatedAt).getTime();
        if (age < AUTH_BLOCK_STALE_MS) {
          const minAgo = Math.round(age / 60000);
          skipReason  = 'SNIPER_BLOCKED_AUTH';
          skipMessage = `Skipped warmup: SNIPER_BLOCKED_AUTH from last run (${minAgo} min ago) — session still likely expired`;
        }
      }

      if (!skipReason && sessionStatus?.valid === false && sessionStatus.checkedAt) {
        const age = Date.now() - new Date(sessionStatus.checkedAt).getTime();
        if (age < AUTH_BLOCK_STALE_MS) {
          const minAgo = Math.round(age / 60000);
          skipReason  = 'SESSION_CHECK_FAILED';
          skipMessage = `Skipped warmup: session check failed ${minAgo} min ago — credentials likely invalid`;
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
    }
  }

  return results;
}

module.exports = { runTick };
