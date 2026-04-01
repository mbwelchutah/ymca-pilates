// Continuous scheduler loop.
// Checks all active DB jobs every 60 seconds and runs the booking bot
// for any job that is in the "warmup" or "sniper" phase.
//
// Usage:  npm run scheduler:loop
// Stop:   Ctrl+C  (or kill the process)

const { getAllJobs, setLastRun } = require('../db/jobs');
const { getPhase }                 = require('./booking-window');
const { runBookingJob }            = require('../bot/register-pilates');

const INTERVAL_MS     = 60 * 1000;      // how often to check (ms)
const COOLDOWN_MS     = 30 * 60 * 1000; // skip if ran within this window (ms)
const ELIGIBLE_PHASES = ['warmup', 'sniper'];

// Returns true if the ISO timestamp falls within the current UTC calendar week
// (Monday 00:00 UTC through Sunday 23:59 UTC).
// Timezone imprecision is acceptable for now — the booking window is ~24h wide.
function isThisWeek(isoStr) {
  if (!isoStr) return false;
  const successDate  = new Date(isoStr);
  const now          = new Date();
  // Roll back to the most recent Monday at midnight UTC.
  const daysSinceMon = (now.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const weekStart    = new Date(now);
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
  return successDate >= weekStart;
}

// In-memory concurrency guard.
// Tracks job ids that are currently being run by the bot.
// If a tick fires while a job is still running, that job is skipped.
const runningJobs = new Set();

function now() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
}

async function runTick() {
  console.log(`\n[${now()}] --- Scheduler tick ---`);

  let jobs;
  try {
    jobs = getAllJobs().filter(j => j.is_active === 1);
  } catch (err) {
    console.error('  ERROR loading jobs:', err.message);
    return;
  }

  console.log(`  Active jobs: ${jobs.length}`);

  for (const dbJob of jobs) {
    const job = {
      classTitle:  dbJob.class_title,
      classTime:   dbJob.class_time,
      dayOfWeek:   dbJob.day_of_week,
      targetDate:  dbJob.target_date || null,
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
      continue;
    }

    // Already-booked guard — skip if this job succeeded during the current week.
    if (isThisWeek(dbJob.last_success_at)) {
      console.log(`  => SKIPPING Job #${dbJob.id} — already booked this week (${dbJob.last_success_at})`);
      continue;
    }

    // Concurrency guard — skip if this job is already running from a previous tick.
    if (runningJobs.has(dbJob.id)) {
      console.log(`  => SKIPPING Job #${dbJob.id} — already running`);
      continue;
    }

    // Cooldown guard — skip if the job ran recently (within COOLDOWN_MS).
    if (dbJob.last_run_at) {
      const msSinceRun = Date.now() - new Date(dbJob.last_run_at).getTime();
      if (msSinceRun < COOLDOWN_MS) {
        const minAgo = Math.round(msSinceRun / 60000);
        const prevResult = dbJob.last_result || 'unknown';
        console.log(`  => SKIPPING Job #${dbJob.id} — ran recently (${minAgo} min ago, last result: ${prevResult})`);
        continue;
      }
    }

    runningJobs.add(dbJob.id);
    console.log(`  => RUNNING Job #${dbJob.id} (marked as running, ${runningJobs.size} job(s) active)...`);

    // lastResult starts as 'error' so a crash in the try block is still recorded.
    let lastResult  = 'error';
    let lastErrMsg  = null;
    try {
      const result = await runBookingJob(job);
      lastResult = result.status;
      if (result.status === 'error') lastErrMsg = result.message || null;
      console.log(`  => FINISHED Job #${dbJob.id}. status: ${result.status} | ${result.message}`);
    } catch (err) {
      lastErrMsg = err.message || 'Uncaught exception';
      console.error(`  => ERROR Job #${dbJob.id}:`, err.message);
    } finally {
      // Persist run timestamp, outcome, and (on error) the failure message.
      setLastRun(dbJob.id, lastResult, lastErrMsg);
      runningJobs.delete(dbJob.id);
      console.log(`  => Job #${dbJob.id} done. result: ${lastResult}. (${runningJobs.size} job(s) still running)`);
    }
  }
}

// Run once immediately, then repeat every 60 seconds.
runTick().catch(err => console.error('Tick error:', err.message));
setInterval(() => {
  runTick().catch(err => console.error('Tick error:', err.message));
}, INTERVAL_MS);

console.log(`Scheduler loop started. Checking every ${INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
