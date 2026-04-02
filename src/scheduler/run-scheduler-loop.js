// Continuous scheduler loop.
// Checks all active DB jobs every 60 seconds and runs the booking bot
// for any job that is in the "warmup" or "sniper" phase.
//
// Usage:  npm run scheduler:loop
// Stop:   Ctrl+C  (or kill the process)

const { runTick }           = require('./tick');
const { isSchedulerPaused } = require('./scheduler-state');

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
}

// Run once immediately, then repeat every 60 seconds.
tick().catch(err => console.error('Tick error:', err.message));
setInterval(() => {
  tick().catch(err => console.error('Tick error:', err.message));
}, INTERVAL_MS);

console.log(`Scheduler loop started. Checking every ${INTERVAL_MS / 1000}s. Press Ctrl+C to stop.`);
