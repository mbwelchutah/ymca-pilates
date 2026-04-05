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
// status should be one of: "success", "already_registered", "found_not_open_yet",
//   "not_found", "error".
// errorMessage: pass the failure/info description for non-success statuses; pass
//   null (or omit) for success/already_registered — it will be cleared in the DB.
//
// last_success_at: set to now on "success"/"already_registered"; COALESCE preserves it otherwise.
// last_error_message: set to errorMessage for non-success statuses; NULL on success.
const SUCCESS_STATUSES = ['success', 'already_registered'];
// Statuses that carry an informational message to show in the dashboard
const MESSAGE_STATUSES = ['error', 'found_not_open_yet', 'not_found'];

function setLastRun(id, status, errorMessage) {
  const db        = openDb();
  const ts        = new Date().toISOString();
  const successAt = SUCCESS_STATUSES.includes(status) ? ts : null;
  const errMsg    = MESSAGE_STATUSES.includes(status) ? (errorMessage || status) : null;
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

// Clears the booking run state so the scheduler will attempt to book again.
// If target_date is set and is already in the past, advances it by 7 days
// (repeating until future) so the bot targets the correct upcoming class.
function clearLastRun(id) {
  const db  = openDb();
  const job = db.prepare('SELECT target_date FROM jobs WHERE id = ?').get(id);
  if (job && job.target_date) {
    const today   = new Date().toISOString().slice(0, 10);
    if (job.target_date < today) {
      const d = new Date(job.target_date + 'T12:00:00Z');
      while (d.toISOString().slice(0, 10) < today) d.setDate(d.getDate() + 7);
      db.prepare('UPDATE jobs SET target_date = ? WHERE id = ?')
        .run(d.toISOString().slice(0, 10), id);
    }
  }
  db.prepare(`
    UPDATE jobs
    SET last_run_at = NULL, last_result = NULL,
        last_error_message = NULL, last_success_at = NULL
    WHERE id = ?
  `).run(id);
}

module.exports = { createJob, getAllJobs, getJobById, setLastRun, updateJob, deleteJob, setJobActive, clearLastRun };
