// Simple CRUD helpers for the jobs table.
// All functions open their own connection — fine for this low-traffic app.
const { openDb } = require('./init');

function createJob(job) {
  const db = openDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (class_title, instructor, day_of_week, class_time, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    job.classTitle,
    job.instructor  || null,
    job.dayOfWeek   || null,
    job.classTime   || null,
    job.isActive !== undefined ? (job.isActive ? 1 : 0) : 1,
    new Date().toISOString()
  );
  return result.lastInsertRowid;
}

function getAllJobs() {
  const db = openDb();
  return db.prepare('SELECT * FROM jobs').all();
}

function getJobById(id) {
  const db = openDb();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// Records the completion time and outcome of a job run.
// status should be "success", "already_registered", "error", or similar —
// whatever result.status the bot returns.
// Call this in the scheduler's finally block so it always fires.
function setLastRun(id, status) {
  const db = openDb();
  db.prepare('UPDATE jobs SET last_run_at = ?, last_result = ? WHERE id = ?')
    .run(new Date().toISOString(), status || null, id);
}

module.exports = { createJob, getAllJobs, getJobById, setLastRun };
