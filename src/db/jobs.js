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

// Records the current UTC time as the last run timestamp for a job.
// Call this after a job finishes (success or failure) so the scheduler
// knows not to re-launch it within the cooldown window.
function setLastRunAt(id) {
  const db = openDb();
  db.prepare('UPDATE jobs SET last_run_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

module.exports = { createJob, getAllJobs, getJobById, setLastRunAt };
