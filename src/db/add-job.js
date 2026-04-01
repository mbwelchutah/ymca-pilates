// CLI script: add a job to the DB.
// Usage:
//   npm run db:add -- --title "Core Pilates" --day Wednesday --time "7:45 AM" \
//                     --instructor "Stephanie Sanders" --target-date 2026-04-08
const { createJob } = require('./jobs');

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const classTitle = flag('title');
if (!classTitle) {
  console.error('ERROR: --title is required.');
  process.exit(1);
}

const job = {
  classTitle,
  dayOfWeek:  flag('day'),
  classTime:  flag('time'),
  instructor: flag('instructor'),
  targetDate: flag('target-date'),
};

const id = createJob(job);
console.log(`Created job #${id}:`);
console.log(`  class_title : ${job.classTitle}`);
console.log(`  day_of_week : ${job.dayOfWeek  || '—'}`);
console.log(`  class_time  : ${job.classTime  || '—'}`);
console.log(`  instructor  : ${job.instructor || '—'}`);
console.log(`  target_date : ${job.targetDate || '—'}`);
