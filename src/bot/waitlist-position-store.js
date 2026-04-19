'use strict';
// waitlist-position-store.js — Task #101 (DB-backed since Task #103)
//
// Tiny key/value accessor for the most recently observed FW waitlist badge
// ("#10 On Waitlist") so it can be surfaced on the Now / Tools UI for as long
// as last_result === 'waitlist'.
//
// Originally backed by data/waitlist-positions.json — Task #103 moved storage
// onto the jobs row itself (jobs.last_waitlist_position) so the value
// survives the same fresh-container restart cleanup that wipes other on-disk
// state, and so it participates in the existing PG mirror without a second
// out-of-band file.
//
// Tolerant of missing/corrupt rows: get() returns null on any error and
// set()/clear() swallow write failures so a transient DB hiccup never breaks
// the booking pipeline.
//
// Durability note (Task #104): set() and clear() write only to SQLite. On
// Replit the container is rebuilt from git on every publish and SQLite is
// re-seeded from PostgreSQL, so a captured position is only durable across
// a fresh-container restart if its caller also queues syncJobsToPgAsync()
// (from src/db/pg-sync.js). The other jobs-row mutators (createJob /
// updateJob / setLastRun-via-server-handlers / clearLastRun-via-/reset-booking)
// already funnel through handlers that await the sync; the post-Reserve
// captures in src/bot/register-pilates.js and the recheck in
// src/bot/waitlist-position-recheck.js do not, so each of those call sites
// queues a sync itself after calling set()/clear() here. The clear() invoked
// from setLastRun() in src/db/jobs.js intentionally does not sync — its
// surrounding handler already does. Any new call site that mutates the
// position must follow the same rule, or the value will be lost on the next
// fresh-container restart.
//
// Usage:
//   const positions = require('./waitlist-position-store');
//   positions.set(jobId, 10);
//   positions.get(jobId);   // 10  (or null)
//   positions.clear(jobId); // forget on reset

const { openDb } = require('../db/init');

function get(jobId) {
  if (jobId == null) return null;
  try {
    const db  = openDb();
    const row = db.prepare('SELECT last_waitlist_position FROM jobs WHERE id = ?').get(jobId);
    if (!row) return null;
    const n = row.last_waitlist_position;
    return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
  } catch (_) {
    return null;
  }
}

function set(jobId, position) {
  if (jobId == null) return;
  if (position == null || !Number.isFinite(position)) return;
  try {
    const db = openDb();
    db.prepare('UPDATE jobs SET last_waitlist_position = ? WHERE id = ?').run(position, jobId);
  } catch (err) {
    console.warn('[waitlist-position-store] write failed (non-fatal):', err.message);
  }
}

function clear(jobId) {
  if (jobId == null) return;
  try {
    const db = openDb();
    db.prepare('UPDATE jobs SET last_waitlist_position = NULL WHERE id = ?').run(jobId);
  } catch (err) {
    console.warn('[waitlist-position-store] clear failed (non-fatal):', err.message);
  }
}

module.exports = { get, set, clear };
