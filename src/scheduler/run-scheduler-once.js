// Scheduler dry-run: checks all active jobs and prints their booking window phase.
// Does NOT launch the bot yet — just shows what would run.
// Usage: npm run scheduler:once
const { getAllJobs } = require('../db/jobs');
const { getPhase } = require('./booking-window');

const fmt = d => d.toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles',
  timeZoneName: 'short',
});

const jobs = getAllJobs();
const activeJobs = jobs.filter(j => j.is_active === 1);

console.log(`Found ${jobs.length} job(s), ${activeJobs.length} active.\n`);

for (const dbJob of activeJobs) {
  const job = {
    classTitle: dbJob.class_title,
    classTime:  dbJob.class_time,
    dayOfWeek:  dbJob.day_of_week,
  };

  const { phase, nextClass, bookingOpen, msUntilOpen } = getPhase(job);

  console.log(`Job #${dbJob.id}: ${dbJob.class_title} — ${dbJob.class_time} (${dbJob.day_of_week})`);
  console.log(`  Phase:        ${phase}`);
  console.log(`  Next class:   ${fmt(nextClass)}`);
  console.log(`  Booking open: ${fmt(bookingOpen)}`);
  console.log(`  Min until open: ${Math.round(msUntilOpen / 60000)}`);

  if (phase === 'warmup' || phase === 'sniper') {
    console.log(`  ✅ ELIGIBLE TO RUN`);
  }

  console.log();
}
