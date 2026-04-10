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
const { loadStatus }       = require('../bot/session-check');
const { isLocked }         = require('../bot/auth-lock');
const { getAuthState, updateAuthState } = require('../bot/auth-state');
const { pingSessionHttp }  = require('../bot/session-ping');
// Stage 2: Use tiered validation (Tier 1→2→3) for recovery so session reuse
// is the default path.  runSessionCheck() skips Tier 1; validateSessionFastThenFallback()
// tries file freshness first and only escalates to HTTP ping or Playwright when needed.
const { validateSessionFastThenFallback } = require('../bot/session-validator');

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
      // Stage 5: recovery triggers on EITHER session not connected OR booking
      // access previously denied.  "Never checked" (bookingAccessConfirmedAt=null)
      // is normal — the browser preflight below will confirm it.  "Checked and
      // denied" (checkedAt set + confirmed=false) is the signal to try recovery
      // before we reach the booking window.
      const authState = getAuthState();
      const bookingAccessDenied = authState.bookingAccessConfirmedAt !== null && !authState.bookingAccessConfirmed;
      const needsRecovery       = authState.status !== 'connected' || bookingAccessDenied;

      // Classify the reason for informational logging.
      let recoveryReason = null;
      if (needsRecovery) {
        if (bookingAccessDenied && authState.status === 'connected') {
          // Session is alive but booking surface was previously denied.
          recoveryReason = 'booking_access_denied';
        } else if (authState.status === 'signed_out') {
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
        const recoveryLabel = recoveryReason === 'booking_access_denied'
          ? 'booking access previously denied'
          : `auth not connected (${recoveryReason})`;
        console.log(
          `[auto-preflight] ${trigger.name} — ${recoveryLabel}; ` +
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
          // Stage 2: Use validateSessionFastThenFallback (Tier 1→2→3) so
          // session reuse is the default path.  Fresh session files (Tier 1)
          // or a fast HTTP ping (Tier 2) resolve without any browser launch.
          // Only Tier 3 (Playwright) is used when truly needed.
          const recovery = await validateSessionFastThenFallback();
          const tierLabel = recovery.tier ? `Tier ${recovery.tier}` : 'unknown';
          const modeLabel = recovery.mode === 'recovery' ? 'credentials used' : 'session reused';
          if (recovery.valid) {
            console.log(`[auto-preflight] ${trigger.name} — recovery succeeded via ${tierLabel} (${modeLabel}); proceeding with preflight.`);
            appendLog({
              timestamp:   new Date().toISOString(),
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'recovery_ok',
              message:     `Auth recovery succeeded via ${tierLabel} (${modeLabel}): ${recovery.detail}`,
            });
          } else {
            console.warn(
              `[auto-preflight] ${trigger.name} — recovery failed via ${tierLabel}: ${recovery.detail}. ` +
              `Proceeding with preflight anyway (cookie injection may still work).`
            );
            appendLog({
              timestamp:   new Date().toISOString(),
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'recovery_failed',
              message:     `Auth recovery failed via ${tierLabel} — ${recovery.detail}`,
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
        // (e.g. ping was slow), the preflight will confirm it via bookingAccessConfirmed.
      }
      // ───────────────────────────────────────────────────────────────────

      running = true;

      const firedAt = new Date().toISOString();
      console.log(`[auto-preflight] ${trigger.name} preflight — Job #${dbJob.id} (${dbJob.class_title})`);

      try {
        // ── Stage 4+5: HTTP ping fast path ────────────────────────────────
        // HTTP ping confirms sessions are alive but cannot probe the booking
        // surface (modal).  We skip the browser ONLY when both conditions hold:
        //   1. Sessions are confirmed via HTTP ping (Daxko + FamilyWorks)
        //   2. Booking access was already confirmed in a prior browser run
        //
        // If booking access is not yet confirmed (bookingAccessConfirmedAt=null
        // = never probed, or confirmed=false = previously denied), we must run
        // the browser so register-pilates.js can probe the modal and set
        // bookingAccessConfirmed.  Skipping would leave us without modal
        // validation until the actual booking window opens.
        const currentAuthState = getAuthState();
        let pingConfirmed = false;
        try {
          const pingResult = await pingSessionHttp();
          if (pingResult.trusted && currentAuthState.bookingAccessConfirmed) {
            // Both sessions confirmed AND booking surface was previously verified.
            console.log(`[auto-preflight] ${trigger.name} confirmed by HTTP ping (booking access confirmed) — skipping browser.`);
            updateAuthState({ daxkoValid: true, familyworksValid: true, lastCheckedAt: Date.now() });
            appendLog({
              timestamp:   firedAt,
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'pass',
              message:     `Session + booking access confirmed via HTTP ping — no browser launch needed`,
            });
            pingConfirmed = true;
          } else if (pingResult.trusted && !currentAuthState.bookingAccessConfirmed) {
            // Sessions alive but booking surface not yet confirmed — browser needed to probe modal.
            console.log(`[auto-preflight] ${trigger.name} ping OK but booking access not confirmed — browser preflight needed to probe modal.`);
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

          const status = (result.status === 'success' || result.status === 'booked') ? 'pass' : 'fail';
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

        // ── Stage 5: T-2 needs-attention signal ───────────────────────────
        // At the last checkpoint before the booking window, if booking access
        // is still not confirmed (not yet probed OR probed and denied), surface
        // a needs_refresh status so the UI shows a warning before the booking
        // moment arrives.  This gives the user a chance to act (e.g. tap Sign
        // In Now) rather than discovering the failure during the live booking.
        if (trigger.name === '2min' && !pingConfirmed) {
          const postPreflight = getAuthState();
          if (!postPreflight.bookingAccessConfirmed) {
            const wasNeverChecked = postPreflight.bookingAccessConfirmedAt === null;
            const warnMsg = wasNeverChecked
              ? 'T-2 warning: booking access has never been confirmed — check may fail at booking time'
              : 'T-2 warning: booking access not confirmed — recovery may have failed';
            console.warn(`[auto-preflight] ${warnMsg}`);
            updateAuthState({ status: 'needs_refresh' });
            appendLog({
              timestamp:   new Date().toISOString(),
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'needs_attention',
              message:     warnMsg,
            });
          }
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
