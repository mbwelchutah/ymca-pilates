// Smoke test for the booking window calculator.
// Run with: npm run scheduler:test
const { getJobById } = require('../db/jobs');
const { getBookingWindow, getPhase } = require('./booking-window');

// Load the sample job from the DB (seeded by npm run db:test)
const dbJob = getJobById(1);
if (!dbJob) {
  console.error('No job found with id 1. Run "npm run db:test" first.');
  process.exit(1);
}

console.log('DB job:', dbJob);
console.log();

// Use camelCase keys that booking-window.js accepts from either shape
const job = {
  classTitle:  dbJob.class_title,
  classTime:   dbJob.class_time,
  dayOfWeek:   dbJob.day_of_week,
};

const { parseTime }              = require('./booking-window');
const { nextClass, bookingOpen } = getBookingWindow(job);
const { phase, msUntilOpen }     = getPhase(job);

const fmt = d => d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
const { hours, minutes } = parseTime(job.classTime);

console.log('Parsed time:   ', `${hours}:${String(minutes).padStart(2, '0')} (hour=${hours}, min=${minutes})`);
console.log('Next class:    ', fmt(nextClass));
console.log('Booking opens: ', fmt(bookingOpen));
console.log('Current phase: ', phase);
console.log('min until open:', Math.round(msUntilOpen / 60000));
