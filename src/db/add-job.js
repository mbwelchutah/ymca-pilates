// CLI script: add a job to the DB.
// Usage:
//   npm run db:add -- --title "Core Pilates" --day Wednesday --time "7:45 AM" \
//                     --instructor "Stephanie Sanders" --target-date 2026-04-08
const { createJob } = require('./jobs');

const args = process.argv.slice(2);

// Reads the value that follows --flagname, or returns null if not found.
function flag(name) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const classTitle = flag('title');
const dayOfWeek  = flag('day');
const classTime  = flag('time');
const instructor = flag('instructor');
const targetDate = flag('target-date'); // optional

// Collect every missing required field and report them all at once.
const missing = [];
if (!classTitle) missing.push('title');
if (!dayOfWeek)  missing.push('day');
if (!classTime)  missing.push('time');
if (!instructor) missing.push('instructor');

if (missing.length > 0) {
  console.error('ERROR: Missing required fields: ' + missing.join(', '));
  console.error('');
  console.error('Usage:');
  console.error('  npm run db:add -- --title "Core Pilates" --day Wednesday \\');
  console.error('                    --time "7:45 AM" --instructor "Stephanie Sanders"');
  console.error('');
  console.error('Optional: --target-date YYYY-MM-DD');
  process.exit(1);
}

const job = { classTitle, dayOfWeek, classTime, instructor, targetDate };

const id = createJob(job);
console.log('Created job #' + id + ':');
console.log('  class_title : ' + job.classTitle);
console.log('  day_of_week : ' + job.dayOfWeek);
console.log('  class_time  : ' + job.classTime);
console.log('  instructor  : ' + job.instructor);
console.log('  target_date : ' + (job.targetDate || '—'));
