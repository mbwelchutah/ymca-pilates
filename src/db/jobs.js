// Simple CRUD helpers for the jobs table.
// All functions open their own connection — fine for this low-traffic app.
const fs   = require('fs');
const path = require('path');
const { openDb } = require('./init');
const SEED_PATH = path.join(__dirname, '../../data/seed-jobs.json');

// Writes the current jobs table to seed-jobs.json.  PostgreSQL sync is now
// awaited explicitly by the server.js mutation handlers so the response is
// only sent after PG is durable — preventing stale restores on server restart.
function syncSeed() {
  try {
    const db   = openDb();
    const jobs = db.prepare('SELECT class_title, instructor, day_of_week, class_time, target_date, is_active FROM jobs').all();
    fs.writeFileSync(SEED_PATH, JSON.stringify(jobs, null, 2), 'utf8');
  } catch (e) {
    console.warn('[db] syncSeed failed (non-fatal):', e.message);
  }
}

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
  syncSeed();
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
const SUCCESS_STATUSES = ['booked', 'success', 'waitlist', 'already_registered'];
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
  syncSeed();
}

function deleteJob(id) {
  const db = openDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  syncSeed();
}

function setJobActive(id, isActive) {
  const db = openDb();
  db.prepare('UPDATE jobs SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  syncSeed();
}

// Clears the booking run state so the scheduler will attempt to book again.
// If target_date is set and is already in the past, advances it by exactly
// 7 days so the bot targets the next upcoming class occurrence.
// syncSeed() is called so seed-jobs.json reflects the potentially-advanced
// target_date; the caller (server.js /reset-booking) awaits syncJobsToPgAsync
// so PG is also durable before the response is sent.
function clearLastRun(id) {
  const db  = openDb();
  const job = db.prepare('SELECT target_date FROM jobs WHERE id = ?').get(id);
  if (job && job.target_date) {
    // Stage 5: use Pacific time for today so same-day classes (where UTC hasn't
    // rolled over yet) are also advanced to next week.  Previously used UTC which
    // left the card stuck on phase:'late' / "Window Closed" after an evening cancel.
    // <= todayPT covers both past dates AND same day (class already ran today).
    const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    if (job.target_date <= todayPT) {
      const d = new Date(job.target_date + 'T12:00:00Z');
      d.setDate(d.getDate() + 7);
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
  syncSeed();
}

// Advances a one-off job's target_date forward by 7-day steps until the new
// class date+time is strictly in the future (Pacific time, including the
// class's class_time — not just the calendar day).  Also clears the
// per-occurrence run state (last_run_at / last_result / last_error_message /
// last_success_at) so the new week's card starts clean and any stale "Issue"
// badge from a prior failed attempt no longer appears.  Returns the updated
// job row, or null when the job doesn't exist or isn't a one-off.
function advanceJobOneWeek(id) {
  // Imported lazily to avoid a circular require with src/scheduler/* which
  // depends on this module for getAllJobs/setLastRun at scheduler boot.
  const { isPastClass } = require('../scheduler/booking-window');
  const db  = openDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job || !job.target_date) return null;

  // Iterate in 7-day steps until the resulting target_date + class_time is no
  // longer past per isPastClass (which compares full Pacific datetime via
  // getBookingWindow).  Hard cap at 520 weeks (~10 years) so a misconfigured
  // class_time that always classifies as past can never spin forever.
  const d = new Date(job.target_date + 'T12:00:00Z');
  let iso = job.target_date;
  let candidate = { ...job, target_date: iso };
  let bumps = 0;
  while (isPastClass(candidate) && bumps < 520) {
    d.setUTCDate(d.getUTCDate() + 7);
    iso = d.toISOString().slice(0, 10);
    candidate = { ...job, target_date: iso };
    bumps++;
  }

  // Re-activate the job when advancing — the user explicitly chose to roll
  // forward, so they want auto-registration on for the new occurrence even if
  // we previously auto-inactivated it during the past-class reconciliation.
  db.prepare(`
    UPDATE jobs
    SET target_date        = ?,
        is_active          = 1,
        last_run_at        = NULL,
        last_result        = NULL,
        last_error_message = NULL,
        last_success_at    = NULL
    WHERE id = ?
  `).run(iso, id);
  // Forget any past-inactivation log gate for this id so future expirations
  // will log once again.
  _pastInactivatedLogged.delete(id);
  syncSeed();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// One-shot log gate so the "inactivating past class" line prints exactly once
// per job per process — not on every API listing or every scheduler tick.
// Cleared when the job becomes future again or is removed (see prune below).
const _pastInactivatedLogged = new Set();

// Reconciles stale state: any one-off (target_date) job whose date+time is
// already past AND still has is_active=1 gets flipped to inactive in SQLite,
// so the storage reflects reality (the scheduler skips it anyway). Also prunes
// the log gate against the current job set so it can't grow unboundedly.
// Called by both the scheduler tick and the API list endpoints so existing
// rows self-heal on the next render even if the scheduler hasn't ticked yet.
//
// Returns the number of jobs that were actually flipped this call (0 when
// everything is already in sync).  Callers may use that to decide whether to
// trigger a PostgreSQL sync.
function inactivatePastJobs() {
  // Lazy require avoids circular dep at module load time.
  const { isPastClass } = require('../scheduler/booking-window');
  const db   = openDb();
  const rows = db.prepare('SELECT id, class_title, target_date, day_of_week, class_time, is_active FROM jobs').all();
  const currentIds = new Set(rows.map(r => r.id));

  // Prune log gate: any ID we've previously logged that no longer exists in
  // the DB (deleted) should be forgotten so the Set can't leak.
  for (const id of _pastInactivatedLogged) {
    if (!currentIds.has(id)) _pastInactivatedLogged.delete(id);
  }

  let flipped = 0;
  for (const r of rows) {
    if (!r.target_date) continue;          // recurring jobs roll forward
    if (!isPastClass(r))  {
      // Job is future again (e.g. user advanced or edited the date) — clear
      // the log gate so a future past state will log once again.
      _pastInactivatedLogged.delete(r.id);
      continue;
    }
    if (r.is_active === 1) {
      db.prepare('UPDATE jobs SET is_active = 0 WHERE id = ?').run(r.id);
      flipped++;
      if (!_pastInactivatedLogged.has(r.id)) {
        console.log(`[past-class] Inactivated job #${r.id} (${r.class_title} ${r.day_of_week} ${r.class_time} on ${r.target_date}) — class has passed; awaiting user advance/keep/remove.`);
        _pastInactivatedLogged.add(r.id);
      }
    }
  }
  if (flipped > 0) syncSeed();
  return flipped;
}

module.exports = { createJob, getAllJobs, getJobById, setLastRun, updateJob, deleteJob, setJobActive, clearLastRun, advanceJobOneWeek, inactivatePastJobs };
