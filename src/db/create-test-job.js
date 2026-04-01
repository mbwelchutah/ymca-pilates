// Creates a fake test job whose booking window opens in ~5 minutes.
//
// How the timing works:
//   bookingOpen = classDatetime - 3 days - 1 hour
//   So to get bookingOpen = now + 5 min:
//   classDatetime = now + 3 days + 1 hour + 5 minutes
//
// The computed day_of_week and class_time are read from that future datetime
// in Pacific timezone so the scheduler's phase math stays consistent.
//
// Usage: npm run db:create-test-job
const { createJob, getAllJobs } = require('./jobs');

const LEAD_DAYS    = 3;
const LEAD_MINUTES = 60;
const BUFFER_MINUTES = 15; // booking opens this many minutes from now

// Compute the target class datetime in Pacific time
const offsetMs = (LEAD_DAYS * 24 * 60 + LEAD_MINUTES + BUFFER_MINUTES) * 60 * 1000;
const classDatetimeUTC = new Date(Date.now() + offsetMs);

// Read day and time components in Pacific timezone
const pacParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday:  'long',
  hour:     'numeric',
  minute:   '2-digit',
  hour12:   true,
}).formatToParts(classDatetimeUTC);

const get = type => pacParts.find(p => p.type === type).value;

const dayOfWeek = get('weekday');                         // e.g. "Wednesday"
const classTime = `${get('hour')}:${get('minute')} ${get('dayPeriod')}`; // e.g. "7:45 AM"

const id = createJob({
  classTitle:  'Core Pilates',
  instructor:  'Stephanie Sanders',
  dayOfWeek,
  classTime,
  isActive:    true,
});

const allJobs = getAllJobs();
const created = allJobs.find(j => j.id === id);

console.log('Created test job:');
console.log(created);
console.log();
console.log(`Booking window opens in ~${BUFFER_MINUTES} minutes.`);
console.log(`Run "npm run scheduler:once" to check the phase.`);
console.log(`Run "npm run scheduler:run"  to launch the bot if eligible.`);
