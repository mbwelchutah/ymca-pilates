// Continuous scheduler loop.
// Checks all active DB jobs every 60 seconds and runs the booking bot
// for any job that is in the "warmup" or "sniper" phase.
//
// Usage:  npm run scheduler:loop
// Stop:   Ctrl+C  (or kill the process)

const { getAllJobs } = require('../db/jobs');
const { getPhase }   = require('./booking-window');
const { runBookingJob } = require('../bot/register-pilates');

const INTERVAL_MS     = 60 * 1000; // 60 seconds
const ELIGIBLE_PHASES = ['warmup', 'sniper'];

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
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      dayOfWeek:  dbJob.day_of_week,
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

    // Concurrency guard — skip if this job is already running from a previous tick.
    if (runningJobs.has(dbJob.id)) {
      console.log(`  => SKIPPING Job #${dbJob.id} — already running`);
      continue;
    }

    runningJobs.add(dbJob.id);
    console.log(`  => RUNNING Job #${dbJob.id} (marked as running, ${runningJobs.size} job(s) active)...`);
    try {
      const result = await runBookingJob(job);
      console.log(`  => FINISHED Job #${dbJob.id}. status: ${result.status} | ${result.message}`);
    } catch (err) {
      console.error(`  => ERROR Job #${dbJob.id}:`, err.message);
    } finally {
      runningJobs.delete(dbJob.id);
      console.log(`  => Job #${dbJob.id} removed from running set (${runningJobs.size} job(s) remaining).`);
    }
  }
}

// Run once immediately, then repeat every 60 seconds.
runTick().catch(err => console.error('Tick error:', err.message));
setInterval(() => {
  runTick().catch(err => console.error('Tick error:', err.message));
}, INTERVAL_MS);

console.log(`Scheduler loop started. Checking every ${INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
