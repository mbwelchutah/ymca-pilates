// Loads a job from the database and runs the booking bot with it.
// Usage: npm run bot:db
const { getJobById } = require('../db/jobs');
const { runBookingJob } = require('./register-pilates');

(async () => {
  // Load job id 1 from the database
  const dbJob = getJobById(1);

  if (!dbJob) {
    console.error('No job found with id 1. Run "npm run db:test" to seed the database.');
    process.exit(1);
  }

  console.log('Loaded DB row:');
  console.log(dbJob);

  // Map DB column names to the shape runBookingJob() expects
  const job = {
    classTitle: dbJob.class_title,
  };

  console.log('\nMapped job object:');
  console.log(job);

  console.log('\nRunning booking bot...');
  const result = await runBookingJob(job);

  console.log('\nResult:');
  console.log(result);

  if (result.status !== 'success') process.exit(1);
})();
