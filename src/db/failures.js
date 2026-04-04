// Structured failure log — records booking failure events with phase + reason taxonomy.
// Phase values:  'login' | 'schedule_scan' | 'card_click' | 'modal_verify' | 'booking' | 'unknown'
// Reason values: 'login_failed' | 'session_expired' | 'class_not_found' |
//                'modal_time_mismatch' | 'modal_instructor_mismatch' | 'modal_mismatch' |
//                'booking_not_open' | 'unexpected_error'

const { openDb } = require('./init');

/**
 * Insert one failure event.
 * @param {{
 *   jobId:      number|null,
 *   phase:      string,
 *   reason:     string,
 *   message:    string|null,
 *   classTitle: string|null,
 *   screenshot: string|null   -- filename only, e.g. "2026-04-04T05-57-24Z-verify-time.png"
 * }} failure
 */
function recordFailure({ jobId, phase, reason, message, classTitle, screenshot }) {
  try {
    const db = openDb();
    db.prepare(`
      INSERT INTO failures (job_id, occurred_at, phase, reason, message, class_title, screenshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId      ?? null,
      new Date().toISOString(),
      phase      || 'unknown',
      reason     || 'unexpected_error',
      message    ?? null,
      classTitle ?? null,
      screenshot ?? null,
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
 * Return aggregated counts:
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

module.exports = { recordFailure, getRecentFailures, getFailureSummary };
