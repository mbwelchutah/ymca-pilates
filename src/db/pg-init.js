// Pre-start script: restores job data from PostgreSQL into seed-jobs.json
// so that a fresh SQLite database seeds from PG state, not the stale git snapshot.
// Run once before the main server starts (see package.json start script).

const { initFromPg } = require('./pg-sync');

initFromPg().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('[pg-init] Fatal error:', err.message);
  process.exit(0); // non-fatal: server can still start from seed-jobs.json
});
