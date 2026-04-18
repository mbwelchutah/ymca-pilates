/**
 * Regression test: runTick({ onlyJobId }) must NOT fan out to other active
 * jobs when past-class auto-inactivation reconciles a row in the same tick.
 *
 * Bug context: inactivatePastJobs() runs at the top of runTick() and may
 * mutate `is_active` for one-off classes whose date+time has passed.  After
 * that mutation the tick re-fetches the active job set; the bug was that the
 * re-fetch dropped the original `onlyJobId` filter, causing
 * /run-selected-scheduler to silently execute every active job.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

describe('runTick({ onlyJobId }) — past-class reconciliation safety', () => {
  let openDb, runTick, futureId, pastId, targetId;
  const insertedIds = [];

  beforeEach(() => {
    // Stub modules with side-effects so the tick is purely a dispatcher test.
    const regPath = _require.resolve('../src/bot/register-pilates');
    _require.cache[regPath] = {
      id: regPath, filename: regPath, loaded: true, exports: {
        runBookingJob: async (j) => ({ status: 'success', message: 'stub-' + j.id }),
        cancelRegistration: async () => ({ ok: true }),
      },
    };
    const dryPath = _require.resolve('../src/bot/dry-run-state');
    _require.cache[dryPath] = {
      id: dryPath, filename: dryPath, loaded: true,
      exports: { getDryRun: () => false },
    };

    ({ openDb } = _require('../src/db/init'));
    ({ runTick } = _require('../src/scheduler/tick'));
    const db = openDb();

    // Clean any leftovers from prior runs
    db.prepare("DELETE FROM jobs WHERE class_title LIKE 'TICKTEST_%'").run();

    futureId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('TICKTEST_FUTURE', 'T', 'Tuesday', '12:00 PM', '2099-04-21', 1, new Date().toISOString()).lastInsertRowid;

    pastId = db.prepare(
      'INSERT INTO jobs (class_title,instructor,day_of_week,class_time,target_date,is_active,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('TICKTEST_PAST', 'T', 'Friday', '12:00 PM', '2000-01-07', 1, new Date().toISOString()).lastInsertRowid;

    // The job we'll target via onlyJobId — the *future* one, distinct from past.
    targetId = futureId;
    insertedIds.push(futureId, pastId);
  });

  afterEach(() => {
    const db = openDb();
    if (insertedIds.length) {
      const placeholders = insertedIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...insertedIds);
      insertedIds.length = 0;
    }
  });

  it('runs only the targeted job even when a past-class is inactivated in the same tick', async () => {
    const results = await runTick({ onlyJobId: targetId });

    // Past job must NOT appear in results — it was inactivated and skipped.
    const ranIds = results.map(r => r.jobId);
    expect(ranIds).not.toContain(pastId);

    // Every result jobId must equal the target.  This catches the regression
    // where the onlyJobId filter was lost on re-fetch and the tick fanned out.
    for (const id of ranIds) {
      expect(id).toBe(targetId);
    }

    // And the past row should be flipped inactive in storage.
    const db = openDb();
    const after = db.prepare('SELECT is_active FROM jobs WHERE id = ?').get(pastId);
    expect(after.is_active).toBe(0);
  });
});
