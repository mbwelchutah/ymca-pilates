// Continuous scheduler loop.
// Checks all active DB jobs every 60 seconds and runs the booking bot
// for any job that is in the "warmup" or "sniper" phase.
//
// Usage:  npm run scheduler:loop
// Stop:   Ctrl+C  (or kill the process)

const { runTick }           = require('./tick');
const { isSchedulerPaused } = require('./scheduler-state');
// Stage 6 (auto-connection-check): background, fire-and-forget cheap/deep
// health checks.  Runs AFTER runTick() so booking work is never delayed.
// All policy + execution lives under src/health/* — this file only invokes.
const { runAutoChecksTick } = require('../health/auto-checks');

const INTERVAL_MS = 60 * 1000;

function now() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
}

async function tick() {
  if (isSchedulerPaused()) {
    console.log(`\n[${now()}] ⏸ Scheduler paused — skipping tick`);
    return;
  }
  await runTick();
  // Stage 6 — fire-and-forget connection-health checks.  runAutoChecksTick()
  // itself returns quickly (it only DECIDES and launches detached promises);
  // we still .catch() so a programming error here can never abort the loop.
  runAutoChecksTick()
    .catch(e => console.warn('[health/auto-checks] tick decision error:', e && e.message));
}

// Run once immediately, then repeat every 60 seconds.
tick().catch(err => console.error('Tick error:', err.message));
setInterval(() => {
  tick().catch(err => console.error('Tick error:', err.message));
}, INTERVAL_MS);

console.log(`Scheduler loop started. Checking every ${INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
