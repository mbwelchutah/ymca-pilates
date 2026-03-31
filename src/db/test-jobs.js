// Quick smoke test for the database layer.
// Run with: npm run db:test
const { openDb } = require('./init');
const { createJob, getAllJobs, getJobById } = require('./jobs');

// Ensure the DB and table exist
openDb();

const existing = getAllJobs();

if (existing.length === 0) {
  console.log('No jobs found — inserting sample job...');
  const id = createJob({
    classTitle:  'Core Pilates',
    instructor:  'Stephanie Sanders',
    dayOfWeek:   'Wednesday',
    classTime:   '7:45 AM',
  });
  console.log('Created job with id:', id);
  console.log('Fetched by id:', getJobById(id));
} else {
  console.log('Jobs already seeded, skipping insert.');
}

console.log('\nAll jobs in database:');
console.table(getAllJobs());
