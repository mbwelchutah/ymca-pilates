// Auto-preflight scheduler (Stage 9.2)
//
// Fires preflight checks at 30 min, 10 min, and 2 min before each job's
// booking window opens.  Each trigger fires at most once per booking cycle
// (keyed by jobId + bookingOpen epoch).  Does NOT run during sniper or late
// phases — the real booking run owns those phases entirely.
//
// Safe to call every 60 s (same cadence as the scheduler tick).
// Does NOT call setLastRun(); preflight results flow only through sniper-state.json.

const fs   = require('fs');
const path = require('path');

const { getAllJobs }       = require('../db/jobs');
const { getPhase }         = require('./booking-window');
const { runBookingJob }    = require('../bot/register-pilates');
const { getDryRun }        = require('../bot/dry-run-state');
const { loadState }        = require('../bot/sniper-readiness');
const { loadStatus, runSessionCheck } = require('../bot/session-check');
const { isLocked }         = require('../bot/auth-lock');
const { getAuthState, updateAuthState } = require('../bot/auth-state');
const { pingSessionHttp }  = require('../bot/session-ping');

// If a real auth run produced a failure within this window, skip preflight
// (same threshold as tick.js warmup gate).
const AUTH_BLOCK_STALE_MS = 20 * 60 * 1000; // 20 minutes

const DATA_DIR      = path.resolve(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'auto-preflight-settings.json');
const LOG_FILE      = path.join(DATA_DIR, 'auto-preflight-log.json');

// ── Trigger definitions ───────────────────────────────────────────────────────
// windowMs:    how far before booking-open the trigger fires (ms)
// toleranceMs: half-width of the firing window — the trigger fires when
//              |msUntilOpen - windowMs| <= toleranceMs.
//              With a 60 s tick and 90 s tolerance, every trigger fires within
//              one tick of its named checkpoint.

const TRIGGERS = [
  { name: '30min', windowMs: 30 * 60 * 1000, toleranceMs: 90 * 1000 },
  { name: '10min', windowMs: 10 * 60 * 1000, toleranceMs: 90 * 1000 },
  { name: '2min',  windowMs:  2 * 60 * 1000, toleranceMs: 90 * 1000 },
];

// ── In-memory state ───────────────────────────────────────────────────────────
// Tracks which trigger keys have already fired this server session.
// Key format: `${jobId}:${bookingOpenMs}:${triggerName}`
const firedThisCycle = new Set();
let running = false;

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { enabled: true };
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch { return { enabled: true }; }
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) { console.warn('[auto-preflight] saveSettings failed:', e.message); }
}

function loadLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function appendLog(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    let entries = loadLog();
    entries.push(entry);
    if (entries.length > 50) entries = entries.slice(-50); // keep last 50
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
  } catch (e) { console.warn('[auto-preflight] appendLog failed:', e.message); }
}

// ── Next-trigger calculator (used by /api/auto-preflight-config) ──────────────

function getNextTrigger() {
  let soonest = null;
  const jobs = getAllJobs().filter(j => j.is_active === 1);

  for (const dbJob of jobs) {
    const job = {
      id:         dbJob.id,
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      instructor: dbJob.instructor  || null,
      dayOfWeek:  dbJob.day_of_week,
      targetDate: dbJob.target_date || null,
    };

    let phaseResult;
    try { phaseResult = getPhase(job); } catch { continue; }
    const { phase, msUntilOpen, bookingOpen } = phaseResult;

    if (phase === 'sniper' || phase === 'late') continue;

    const bookingOpenMs = bookingOpen.getTime();

    for (const trigger of TRIGGERS) {
      const cycleKey = `${dbJob.id}:${bookingOpenMs}:${trigger.name}`;
      if (firedThisCycle.has(cycleKey)) continue;

      const msUntilTrigger = msUntilOpen - trigger.windowMs;
      if (msUntilTrigger < 0) continue; // already past (not in window)

      if (!soonest || msUntilTrigger < soonest.msUntil) {
        soonest = {
          jobId:       dbJob.id,
          triggerName: trigger.name,
          msUntil:     msUntilTrigger,
        };
      }
    }
  }

  return soonest; // null if no upcoming trigger
}

// ── Main check function ───────────────────────────────────────────────────────
// Call this every tick.  isActive: true when a booking run is in progress
// (prevents launching a browser while another is already open).

async function checkAutoPreflights({ isActive = false } = {}) {
  const settings = loadSettings();
  if (!settings.enabled) return;
  if (running)           return; // prior preflight not finished
  if (isActive)          return; // booking run is live — stay out of the way

  const jobs = getAllJobs().filter(j => j.is_active === 1);

  for (const dbJob of jobs) {
    const job = {
      id:         dbJob.id,
      classTitle: dbJob.class_title,
      classTime:  dbJob.class_time,
      instructor: dbJob.instructor  || null,
      dayOfWeek:  dbJob.day_of_week,
      targetDate: dbJob.target_date || null,
    };

    let phaseResult;
    try { phaseResult = getPhase(job); } catch { continue; }
    const { phase, msUntilOpen, bookingOpen } = phaseResult;

    // Sniper and late phases are owned by the real booking run.
    if (phase === 'sniper' || phase === 'late') continue;

    const bookingOpenMs = bookingOpen.getTime();

    for (const trigger of TRIGGERS) {
      const cycleKey = `${dbJob.id}:${bookingOpenMs}:${trigger.name}`;
      if (firedThisCycle.has(cycleKey)) continue;

      // Fire when msUntilOpen is within ±toleranceMs of the trigger point.
      const deviation = Math.abs(msUntilOpen - trigger.windowMs);
      if (deviation > trigger.toleranceMs) continue;

      // ── Trigger fires ────────────────────────────────────────────────────
      firedThisCycle.add(cycleKey); // mark before await so parallel ticks skip

      // ── Stage 3: Auth-recovery gate ─────────────────────────────────────
      // Old behaviour: skip the checkpoint entirely if auth looks bad.
      // New behaviour: if auth is not 'connected', attempt runSessionCheck()
      // to recover BEFORE running the preflight.  This gives three safety
      // nets (T-30 / T-10 / T-2 min) where a stale or expired session is
      // refreshed well before the booking window opens.
      //
      // The only hard-skip is when the auth lock is already held (a
      // concurrent login or booking is in progress — racing it would break
      // both).  Everything else — signed_out, needs_refresh, BLOCKED_AUTH,
      // session-check failure — triggers a recovery attempt instead.

      if (isLocked()) {
        console.log(`[auto-preflight] ${trigger.name} skipped — auth lock held (concurrent operation in progress).`);
        appendLog({ timestamp: new Date().toISOString(), jobId: dbJob.id, classTitle: dbJob.class_title, triggerName: trigger.name, status: 'skipped', message: 'Auth lock held — concurrent session operation in progress' });
        continue;
      }

      // ── Recovery decision ──────────────────────────────────────────────
      const authState = getAuthState();
      const needsRecovery = authState.status !== 'connected';

      // Classify the reason for informational logging.
      let recoveryReason = null;
      if (needsRecovery) {
        if (authState.status === 'signed_out') {
          recoveryReason = 'signed_out';
        } else {
          // needs_refresh / recovering — check legacy signals for more detail.
          const sniperState   = loadState();
          const sessionStatus = loadStatus();
          if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH') {
            const refTime = sniperState.authBlockedAt || sniperState.updatedAt;
            if (refTime && (Date.now() - new Date(refTime).getTime()) < AUTH_BLOCK_STALE_MS) {
              const minAgo = Math.round((Date.now() - new Date(refTime).getTime()) / 60000);
              recoveryReason = `SNIPER_BLOCKED_AUTH (${minAgo} min ago)`;
            }
          }
          if (!recoveryReason && sessionStatus?.valid === false && sessionStatus.checkedAt) {
            const age = Date.now() - new Date(sessionStatus.checkedAt).getTime();
            if (age < AUTH_BLOCK_STALE_MS) {
              const minAgo = Math.round(age / 60000);
              recoveryReason = `session-check failed (${minAgo} min ago)`;
            }
          }
          if (!recoveryReason) recoveryReason = `status=${authState.status}`;
        }
      }

      if (needsRecovery) {
        console.log(
          `[auto-preflight] ${trigger.name} — auth not connected (${recoveryReason}); ` +
          `attempting recovery before preflight.`
        );
        appendLog({
          timestamp:   new Date().toISOString(),
          jobId:       dbJob.id,
          classTitle:  dbJob.class_title,
          triggerName: trigger.name,
          status:      'recovery_attempt',
          message:     `Auth recovery triggered — reason: ${recoveryReason}`,
        });
        try {
          const recovery = await runSessionCheck({ source: `auto-recovery:${trigger.name}` });
          if (recovery.valid) {
            console.log(`[auto-preflight] ${trigger.name} — recovery succeeded; proceeding with preflight.`);
            appendLog({
              timestamp:   new Date().toISOString(),
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'recovery_ok',
              message:     `Auth recovery succeeded (${recovery.detail})`,
            });
          } else {
            console.warn(
              `[auto-preflight] ${trigger.name} — recovery failed: ${recovery.detail}. ` +
              `Proceeding with preflight anyway (Stage-1 cookie injection may still work).`
            );
            appendLog({
              timestamp:   new Date().toISOString(),
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'recovery_failed',
              message:     `Auth recovery failed — ${recovery.detail}`,
            });
          }
        } catch (recoveryErr) {
          console.error(`[auto-preflight] ${trigger.name} — recovery threw:`, recoveryErr.message);
          appendLog({
            timestamp:   new Date().toISOString(),
            jobId:       dbJob.id,
            classTitle:  dbJob.class_title,
            triggerName: trigger.name,
            status:      'recovery_error',
            message:     `Auth recovery error — ${recoveryErr.message}`,
          });
        }
        // Whether recovery succeeded or failed, continue to the preflight.
        // A failed recovery is still useful: if the session was actually OK
        // (e.g. ping was slow), the preflight will confirm it via bookingSurfaceValid.
      }
      // ───────────────────────────────────────────────────────────────────

      running = true;

      const firedAt = new Date().toISOString();
      console.log(`[auto-preflight] ${trigger.name} preflight — Job #${dbJob.id} (${dbJob.class_title})`);

      try {
        // ── Stage 4: Fast confirmation via HTTP ping ──────────────────────
        // Before spending 30-60 s on a full browser preflight, run the Tier-2
        // HTTP ping.  If both sessions are confirmed valid, record the result
        // and skip the browser entirely.  Only fall through to runBookingJob
        // when the ping is inconclusive or misses.
        let pingConfirmed = false;
        try {
          const pingResult = await pingSessionHttp();
          if (pingResult.trusted) {
            console.log(`[auto-preflight] ${trigger.name} confirmed by HTTP ping — skipping browser.`);
            updateAuthState({ daxkoValid: true, familyworksValid: true, lastCheckedAt: Date.now() });
            appendLog({
              timestamp:   firedAt,
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'pass',
              message:     `Session confirmed via HTTP ping — no browser launch needed`,
            });
            pingConfirmed = true;
          } else {
            console.log(`[auto-preflight] ${trigger.name} ping miss (${pingResult.detail}) — running full preflight.`);
          }
        } catch (pingErr) {
          console.log(`[auto-preflight] ${trigger.name} ping error: ${pingErr.message} — running full preflight.`);
        }

        if (!pingConfirmed) {
          const result = await runBookingJob({
            id:          dbJob.id,
            classTitle:  dbJob.class_title,
            classTime:   dbJob.class_time,
            instructor:  dbJob.instructor  || null,
            dayOfWeek:   dbJob.day_of_week,
            targetDate:  dbJob.target_date || null,
            maxAttempts: 1,
          }, { preflightOnly: true, dryRun: getDryRun() });

          const status = result.status === 'success' ? 'pass' : 'fail';
          console.log(`[auto-preflight] ${trigger.name} done — ${status}: ${result.message}`);

          appendLog({
            timestamp:   firedAt,
            jobId:       dbJob.id,
            classTitle:  dbJob.class_title,
            triggerName: trigger.name,
            status,
            message:     result.message,
          });
        }
      } catch (err) {
        console.error(`[auto-preflight] ${trigger.name} error:`, err.message);
        appendLog({
          timestamp:   firedAt,
          jobId:       dbJob.id,
          classTitle:  dbJob.class_title,
          triggerName: trigger.name,
          status:      'error',
          message:     err.message,
        });
      } finally {
        running = false;
      }
    }
  }
}

module.exports = {
  checkAutoPreflights,
  loadSettings,
  saveSettings,
  loadLog,
  getNextTrigger,
};
