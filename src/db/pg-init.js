// Pre-start script: restores job data from PostgreSQL into seed-jobs.json
// so that a fresh SQLite database seeds from PG state, not the stale git snapshot.
// Run once before the main server starts (see package.json start script).
//
// On success, writes data/.pg-init-status.json as a marker that tells the
// server process it's safe to run syncJobsToPgAsync (which does DELETE+INSERT
// against the jobs table).  If initFromPg fails (e.g. PG unreachable), the
// marker is NOT written, which causes the server's sync path to refuse to run
// and prevents a stale SQLite from wiping good PG data.

const fs   = require('fs');
const path = require('path');
const { initFromPg }            = require('./pg-sync');
const { restoreFailuresFromPg, pruneFailuresInPg } = require('./pg-failures');

const MARKER = path.join(__dirname, '../../data/.pg-init-status.json');
// Stale restore-status marker from a previous boot would mislead the Failure
// Insights panel into showing yesterday's restore as if it happened today, so
// wipe it up front and let restoreFailuresFromPg() re-stamp the real outcome.
const RESTORE_STATUS = path.join(__dirname, '../../data/.pg-failures-restore-status.json');

// Remove any stale marker from a previous boot before attempting this init.
// If pg-init fails this time, the absence of the marker must reflect THIS run.
try { fs.unlinkSync(MARKER); } catch (_) { /* absent is fine */ }
try { fs.unlinkSync(RESTORE_STATUS); } catch (_) { /* absent is fine */ }

initFromPg().then(async () => {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(
      MARKER,
      JSON.stringify({ ok: true, ts: new Date().toISOString() }, null, 2),
      'utf8'
    );
    console.log('[pg-init] marker written — server sync path is unlocked.');
  } catch (e) {
    console.error('[pg-init] failed to write marker (server will refuse to sync):', e.message);
  }

  // Enforce the PG `failures` retention policy before restoring into SQLite,
  // so stale rows are dropped at the source rather than copied into the fresh
  // local DB.  Pruning is cheap (indexed range delete) and safe to run on
  // every boot; this is the "scheduled" trigger called for in task #92.
  try {
    await pruneFailuresInPg();
  } catch (e) {
    console.error('[pg-init] failure-history prune failed (non-fatal):', e.message);
  }

  // Failure history is wiped with SQLite on every container redeploy.  Pull
  // the durable PG mirror back into the freshly-bootstrapped SQLite so the
  // Failure Insights panel survives the restart.  Errors are non-fatal — the
  // panel will simply start empty if PG is unreachable.
  try {
    await restoreFailuresFromPg();
  } catch (e) {
    console.error('[pg-init] failure-history restore failed (non-fatal):', e.message);
  }

  process.exit(0);
}).catch((err) => {
  console.error('[pg-init] Fatal error:', err.message);
  console.error('[pg-init] marker NOT written — server will refuse syncJobsToPgAsync until next successful restart.');
  // Non-fatal for the server process: it can still read from seed-jobs.json.
  // But mutations that would push SQLite → PG will be blocked, preventing a
  // potentially-stale SQLite from wiping good PG data.
  process.exit(0);
});
