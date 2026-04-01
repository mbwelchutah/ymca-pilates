// Deletes Core Pilates test jobs that are older than 24 hours.
// Safe: only removes jobs where class_title = 'Core Pilates' AND created_at < 24h ago.
// Usage: npm run db:cleanup-test-jobs
const { openDb } = require('./init');

const db = openDb();

const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const deleted = db.prepare(`
  DELETE FROM jobs
  WHERE class_title = 'Core Pilates'
    AND created_at < ?
`).run(cutoff);

const remaining = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;

console.log(`Deleted ${deleted.changes} old test job(s) (created before ${cutoff}).`);
console.log(`Remaining jobs in database: ${remaining}`);
