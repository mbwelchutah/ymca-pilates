// Structured failure log — records booking failure events with phase + reason taxonomy.
//
// Phase taxonomy:
//   system     — job validation / process-level errors
//   auth       — login, session check, mid-flow auth guard
//   navigate   — page navigation, filter application, schedule render check
//   scan       — class row search / scoring
//   verify     — modal identity verification (time, instructor)
//   click      — card click attempt (normal + force fallback)
//   gate       — booking button availability check
//   action     — register / waitlist click
//   post_click — post-click confirmation state check
//   recovery   — stale-card / stale-row retry logic
//   unknown    — unclassified catch-block errors
//
// Reason taxonomy:
//   invalid_job_params          — job object missing required fields
//   login_failed                — Daxko login rejected / timed out
//   session_expired             — "Login to Register" prompt appeared
//   filter_apply_failed         — category/instructor filter had no effect
//   schedule_not_rendered       — 0 class rows visible after filter application
//   class_not_found             — no card passed confidence threshold
//   modal_time_mismatch         — modal showed wrong class time
//   modal_instructor_mismatch   — modal showed wrong instructor
//   modal_mismatch              — modal showed wrong time AND instructor
//   click_fallback              — normal click failed, force-click used
//   booking_not_open            — Register/Waitlist button absent
//   registration_unclear        — Register clicked, no confirmation text
//   stale_card_recovery_failed  — card could not be re-located after reload
//   unexpected_error            — unclassified exception

const { openDb } = require('./init');

/**
 * Insert one failure event.
 *
 * @param {{
 *   jobId:      number|null,
 *   phase:      string,
 *   reason:     string,
 *   message:    string|null,
 *   classTitle: string|null,
 *   screenshot: string|null   -- filename only, e.g. "2026-04-05T06-45-00Z-verify-time.png"
 *   category:   string|null   -- broad grouping matching phase (e.g. 'auth', 'scan')
 *   label:      string|null   -- human-readable one-liner
 *   expected:   string|null   -- expected value (JSON string or plain text)
 *   actual:     string|null   -- actual value observed
 *   url:        string|null   -- page URL at time of failure
 *   context:    object|null   -- limited debug key/value pairs (stored as JSON)
 * }} failure
 */
function recordFailure({
  jobId, phase, reason, message, classTitle, screenshot,
  category = null, label = null, expected = null, actual = null,
  url = null, context = null,
}) {
  try {
    const db = openDb();
    db.prepare(`
      INSERT INTO failures
        (job_id, occurred_at, phase, reason, message, class_title, screenshot,
         category, label, expected, actual, url, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId      ?? null,
      new Date().toISOString(),
      phase      || 'unknown',
      reason     || 'unexpected_error',
      message    ?? null,
      classTitle ?? null,
      screenshot ?? null,
      category   ?? null,
      label      ?? null,
      expected   ?? null,
      actual     ?? null,
      url        ?? null,
      context != null ? JSON.stringify(context) : null,
    );
    db.close();
  } catch (e) {
    console.error('[failures] recordFailure error:', e.message);
  }
}

/**
 * Return the N most-recent failure rows, newest first.
 */
function getRecentFailures(limit = 20) {
  const db   = openDb();
  const rows = db.prepare(
    'SELECT * FROM failures ORDER BY occurred_at DESC LIMIT ?'
  ).all(limit);
  db.close();
  return rows;
}

/**
 * Return all-time aggregated counts:
 *   byReason  — [{ reason, count }] sorted by count desc
 *   byPhase   — [{ phase,  count }] sorted by count desc
 */
function getFailureSummary() {
  const db = openDb();
  const byReason = db.prepare(
    'SELECT reason, COUNT(*) AS count FROM failures GROUP BY reason ORDER BY count DESC'
  ).all();
  const byPhase = db.prepare(
    'SELECT phase, COUNT(*) AS count FROM failures GROUP BY phase ORDER BY count DESC'
  ).all();
  db.close();
  return { byReason, byPhase };
}

/**
 * Return windowed aggregates for a given time window.
 *
 * @param {{ sinceIso: string }} opts  ISO timestamp — only failures at or after this time are included.
 * @returns {{ byReason: Array<{reason:string,count:number}>, byPhase: Array<{phase:string,count:number}>, total: number }}
 */
function getFailureTrends({ sinceIso }) {
  const db = openDb();
  const byReason = db.prepare(
    `SELECT reason, COUNT(*) AS count FROM failures WHERE occurred_at >= ? GROUP BY reason ORDER BY count DESC`
  ).all(sinceIso);
  const byPhase = db.prepare(
    `SELECT phase, COUNT(*) AS count FROM failures WHERE occurred_at >= ? GROUP BY phase ORDER BY count DESC`
  ).all(sinceIso);
  const total = byReason.reduce((s, r) => s + r.count, 0);
  db.close();
  return { byReason, byPhase, total };
}

/**
 * Return per-job failure aggregates for a given time window, split by the
 * transient-vs-actionable taxonomy in src/scheduler/failure-classification.js.
 *
 * Returns: [{ job_id, failure_count, transient_count, top_reason }]
 *   - failure_count   actionable (non-transient) failures only
 *   - transient_count expected-retry failures hidden from the rollup
 *   - top_reason      the highest-count actionable reason (null if none)
 *
 * Jobs are only included if they had >=1 failure of either kind.
 * The raw `failures` table is unchanged — this is a read-side filter so the
 * detailed log keeps every row.
 */
function getFailuresByJob({ sinceIso }) {
  const { isTransient } = require('../scheduler/failure-classification');
  const db = openDb();

  const rows = db.prepare(`
    SELECT job_id, reason, COUNT(*) AS cnt
    FROM failures
    WHERE occurred_at >= ? AND job_id IS NOT NULL
    GROUP BY job_id, reason
  `).all(sinceIso);

  db.close();

  const byJob = new Map();
  for (const r of rows) {
    let e = byJob.get(r.job_id);
    if (!e) {
      e = { job_id: r.job_id, failure_count: 0, transient_count: 0, top_reason: null, _topCnt: 0 };
      byJob.set(r.job_id, e);
    }
    if (isTransient(r.reason)) {
      e.transient_count += r.cnt;
    } else {
      e.failure_count += r.cnt;
      if (r.cnt > e._topCnt) {
        e._topCnt = r.cnt;
        e.top_reason = r.reason;
      }
    }
  }

  return Array.from(byJob.values()).map(({ _topCnt, ...rest }) => rest);
}

/**
 * Delete all rows from the failures table and stamp the reset timestamp so
 * the UI can label the trends panel as "since <reset>" instead of all-time.
 */
function clearFailures() {
  const db = openDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM failures').run();
    db.prepare(
      `INSERT INTO failures_meta (key, value) VALUES ('resetAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(new Date().toISOString());
  });
  tx();
  db.close();
}

/**
 * Return the ISO timestamp at which the failure history was last reset
 * (either by a fresh-DB bootstrap on container restart, or by an explicit
 * clearFailures() call).  Returns null if the metadata row is somehow absent.
 */
function getFailuresResetAt() {
  const db = openDb();
  const row = db.prepare(
    `SELECT value FROM failures_meta WHERE key = 'resetAt'`
  ).get();
  db.close();
  return row ? row.value : null;
}

module.exports = { recordFailure, getRecentFailures, getFailureSummary, getFailureTrends, getFailuresByJob, clearFailures, getFailuresResetAt };
