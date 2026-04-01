// Simple CRUD helpers for the jobs table.
// All functions open their own connection — fine for this low-traffic app.
const { openDb } = require('./init');

function createJob(job) {
  const db = openDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (class_title, instructor, day_of_week, class_time, target_date, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    job.classTitle,
    job.instructor  || null,
    job.dayOfWeek   || null,
    job.classTime   || null,
    job.targetDate  || null,
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
// status should be "success", "already_registered", "error", or similar.
// errorMessage: pass the failure description when status === "error"; pass
//   null (or omit) for all other outcomes — it will be cleared in the DB.
//
// last_success_at: set to now on "success"; COALESCE preserves it otherwise.
// last_error_message: set to errorMessage on "error"; NULL on any success/clean exit.
function setLastRun(id, status, errorMessage) {
  const db        = openDb();
  const ts        = new Date().toISOString();
  const successAt = status === 'success' ? ts : null;
  const errMsg    = status === 'error' ? (errorMessage || 'Unknown error') : null;
  db.prepare(`
    UPDATE jobs
    SET last_run_at         = ?,
        last_result         = ?,
        last_error_message  = ?,
        last_success_at     = COALESCE(?, last_success_at)
    WHERE id = ?
  `).run(ts, status || null, errMsg, successAt, id);
}

function updateJob(id, fields) {
  const db = openDb();
  db.prepare(`
    UPDATE jobs
    SET class_title = ?, day_of_week = ?, class_time = ?, instructor = ?, target_date = ?
    WHERE id = ?
  `).run(
    fields.classTitle,
    fields.dayOfWeek   || null,
    fields.classTime   || null,
    fields.instructor  || null,
    fields.targetDate  || null,
    id
  );
}

function deleteJob(id) {
  const db = openDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function setJobActive(id, isActive) {
  const db = openDb();
  db.prepare('UPDATE jobs SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
}

module.exports = { createJob, getAllJobs, getJobById, setLastRun, updateJob, deleteJob, setJobActive };
