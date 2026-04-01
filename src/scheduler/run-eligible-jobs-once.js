// Scheduler: loads active jobs, checks booking window phase, and launches
// eligible jobs (warmup or sniper phase) exactly once per run.
// Usage: npm run scheduler:run
const { getAllJobs } = require('../db/jobs');
const { getPhase } = require('./booking-window');
const { runBookingJob } = require('../bot/register-pilates');

const ELIGIBLE_PHASES = ['warmup', 'sniper'];

(async () => {
  const jobs = getAllJobs();
  const activeJobs = jobs.filter(j => j.is_active === 1);

  console.log(`Found ${jobs.length} job(s), ${activeJobs.length} active.\n`);

  for (const dbJob of activeJobs) {
    const job = {
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      dayOfWeek:  dbJob.day_of_week,
    };

    const { phase } = getPhase({
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      dayOfWeek:  dbJob.day_of_week,
    });

    if (!ELIGIBLE_PHASES.includes(phase)) {
      console.log(`SKIPPING Job #${dbJob.id} (${dbJob.class_title}) — phase: ${phase}`);
      continue;
    }

    console.log(`RUNNING Job #${dbJob.id} (${dbJob.class_title}) — phase: ${phase}`);
    const result = await runBookingJob(job);

    console.log(`Result for Job #${dbJob.id}:`);
    console.log(`  status:  ${result.status}`);
    console.log(`  message: ${result.message}`);
    if (result.screenshotPath) {
      console.log(`  screenshot: ${result.screenshotPath}`);
    }
    console.log();
  }

  console.log('Scheduler run complete.');
})();
