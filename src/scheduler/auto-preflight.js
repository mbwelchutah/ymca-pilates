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

const { writeJsonAtomic } = require('../util/atomic-json');
const { getAllJobs }       = require('../db/jobs');
const { getPhase }         = require('./booking-window');
const { runBookingJob }    = require('../bot/register-pilates');
const { getDryRun }        = require('../bot/dry-run-state');
const { loadState, updateLastSuccessfulPreflightAt } = require('../bot/sniper-readiness');
const { isLocked }         = require('../bot/auth-lock');
// Task #79 — auth truth (including the lastCheckedAt + lastFailureType fields
// that previously came from session-status.json via loadStatus()) now flows
// exclusively through the canonical accessor.
const { getAuthState, updateAuthState, getCanonicalAuthTruth } = require('../bot/auth-state');
const { pingSessionHttp }  = require('../bot/session-ping');
const { isCacheAdequate }  = require('../classifier/scheduleCache');
// Stage 4 (freshness) — persist canonical readiness state after every preflight.
const { refreshConfirmedReadyState } = require('../bot/confirmed-ready');
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
// Task #76 — durable record of which (jobId, bookingOpenMs, trigger) keys have
// already fired.  Survives server restarts so a routine restart between T-30
// and T-2 cannot re-fire T-30 inside its 90-second tolerance window.
const FIRED_FILE    = path.join(DATA_DIR, 'auto-preflight-fired.json');

// ── Trigger definitions ───────────────────────────────────────────────────────
// windowMs:    how far before booking-open the trigger fires (ms)
// toleranceMs: half-width of the firing window — the trigger fires when
//              |msUntilOpen - windowMs| <= toleranceMs.
//              With a 60 s tick and 90 s tolerance, every trigger fires within
//              one tick of its named checkpoint.

// Density ramps up the closer we get to booking-open:
//   - Coarse pre-window deep verifies (6h, 3h, 1h) catch UI/auth regressions
//     hours before they would matter, instead of waiting for T-30 to discover
//     that the schedule URL changed or filters broke.
//   - The fine-grained 30/10/2-min checkpoints remain unchanged.
//   - Between checkpoints, the 12-min HTTP session-keepalive continues running.
// Each trigger fires at most once per (jobId, bookingOpenMs) cycle and is
// persisted to disk (FIRED_FILE) so a restart can't replay a checkpoint.
const TRIGGERS = [
  { name: '6h',    windowMs: 6 * 60 * 60 * 1000, toleranceMs: 5 * 60 * 1000 },
  { name: '3h',    windowMs: 3 * 60 * 60 * 1000, toleranceMs: 5 * 60 * 1000 },
  { name: '1h',    windowMs:     60 * 60 * 1000, toleranceMs: 2 * 60 * 1000 },
  { name: '30min', windowMs: 30 * 60 * 1000, toleranceMs: 90 * 1000 },
  { name: '10min', windowMs: 10 * 60 * 1000, toleranceMs: 90 * 1000 },
  { name: '2min',  windowMs:  2 * 60 * 1000, toleranceMs: 90 * 1000 },
];

// ── In-memory state ───────────────────────────────────────────────────────────
// Tracks which trigger keys have already fired this server session.
// Key format: `${jobId}:${bookingOpenMs}:${triggerName}`
//
// Task #76 — `firedThisCycle` is the hot-path read cache.  It is hydrated
// from FIRED_FILE on first access (`ensureFiredHydrated`) and every fire is
// also persisted via `persistFired()` so a server restart cannot replay a
// checkpoint that already ran.
const firedThisCycle = new Set();
// Companion record: cycleKey → { bookingOpenMs, firedAt } so we can trim
// expired entries on read without parsing the key.
const firedDisk = new Map();
let firedHydrated = false;
let running = false;

// How long after bookingOpen we keep a fired record on disk.  After this
// window the booking is over and the in-memory cycleKey is no longer
// reachable, so trimming is safe.
const FIRED_TTL_AFTER_OPEN_MS = 60 * 60 * 1000; // 1 hour

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { enabled: true };
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch { return { enabled: true }; }
}

function saveSettings(settings) {
  try {
    writeJsonAtomic(SETTINGS_FILE, settings);
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
    let entries = loadLog();
    entries.push(entry);
    if (entries.length > 50) entries = entries.slice(-50); // keep last 50
    writeJsonAtomic(LOG_FILE, entries);
  } catch (e) { console.warn('[auto-preflight] appendLog failed:', e.message); }
}

// ── Task #76 — durable fired-checkpoint record ────────────────────────────────
//
// File shape:
//   { "<jobId>:<bookingOpenMs>:<triggerName>": { bookingOpenMs, firedAt }, ... }
//
// `bookingOpenMs` is duplicated as a record field so trimming does not depend
// on parsing the key (key format is internal, the field is the contract).

function loadFiredFromDisk() {
  try {
    if (!fs.existsSync(FIRED_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    console.warn('[auto-preflight] loadFiredFromDisk failed:', e.message);
    return {};
  }
}

function persistFired() {
  try {
    const out = {};
    for (const [key, entry] of firedDisk.entries()) out[key] = entry;
    writeJsonAtomic(FIRED_FILE, out);
  } catch (e) {
    console.warn('[auto-preflight] persistFired failed:', e.message);
  }
}

/** Hydrate the in-memory Set from disk on first access, dropping any
 *  records whose bookingOpenMs is older than FIRED_TTL_AFTER_OPEN_MS so the
 *  file cannot grow without bound across booking cycles. */
function ensureFiredHydrated() {
  if (firedHydrated) return;
  firedHydrated = true;
  const disk = loadFiredFromDisk();
  const cutoff = Date.now() - FIRED_TTL_AFTER_OPEN_MS;
  let trimmed = 0;
  for (const [key, entry] of Object.entries(disk)) {
    const bookingOpenMs = entry && typeof entry === 'object' ? entry.bookingOpenMs : null;
    if (typeof bookingOpenMs !== 'number' || bookingOpenMs < cutoff) {
      trimmed++;
      continue;
    }
    firedThisCycle.add(key);
    firedDisk.set(key, entry);
  }
  // If we dropped anything, rewrite the file so subsequent reads are quick.
  if (trimmed > 0) persistFired();
}

/** Mark a cycle key as fired, in memory and on disk. */
function recordFired(cycleKey, bookingOpenMs) {
  ensureFiredHydrated();
  if (firedThisCycle.has(cycleKey)) return;
  firedThisCycle.add(cycleKey);
  firedDisk.set(cycleKey, { bookingOpenMs, firedAt: new Date().toISOString() });
  persistFired();
}

// ── Next-trigger calculator (used by /api/auto-preflight-config) ──────────────

function getNextTrigger() {
  ensureFiredHydrated();
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

  // Task #76 — load durable fired-checkpoint record before the gate check
  // below, so a checkpoint that fired in a previous server lifetime is not
  // re-fired inside its 90-second tolerance window after restart.
  ensureFiredHydrated();

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
      // Task #76 — record durably *before* the await so a crash mid-preflight
      // still prevents a re-fire when the server comes back up.  The Set
      // mutation here is what blocks parallel ticks within this process; the
      // file write is what blocks re-fires across process restarts.
      recordFired(cycleKey, bookingOpenMs);

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
          // Task #79 — replace loadStatus() (session-status.json) with the
          // canonical accessor.  sessionValid + lastCheckedAt mirror the
          // legacy file's `valid` and `checkedAt` fields exactly.
          const canonicalAuth = getCanonicalAuthTruth();
          if (sniperState?.sniperState === 'SNIPER_BLOCKED_AUTH') {
            const refTime = sniperState.authBlockedAt || sniperState.updatedAt;
            if (refTime && (Date.now() - new Date(refTime).getTime()) < AUTH_BLOCK_STALE_MS) {
              const minAgo = Math.round((Date.now() - new Date(refTime).getTime()) / 60000);
              recoveryReason = `SNIPER_BLOCKED_AUTH (${minAgo} min ago)`;
            }
          }
          if (!recoveryReason && canonicalAuth.sessionValid === false && canonicalAuth.lastCheckedAt != null) {
            const age = Date.now() - canonicalAuth.lastCheckedAt;
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
          // Stage 3: The browser fast-path is only valid when the schedule cache
          // is still fresh enough (≤ 4 h old).  A stale or absent cache means we
          // have not confirmed class availability recently — the browser must run
          // so Playwright's API interception can repopulate the schedule cache.
          // Without this guard the ping fast-path would silently prevent cache
          // refresh across multiple successive auto-preflight checkpoints.
          const cacheOk = isCacheAdequate();

          if (pingResult.trusted && currentAuthState.bookingAccessConfirmed && cacheOk) {
            // Sessions confirmed + booking access confirmed + cache is fresh — skip browser.
            // Stage 5 (ping fast-path freshness): confirmed-ready-state.json is refreshed
            // unconditionally below (line 410) regardless of this branch.  Auth freshness
            // is updated here so confirmed-ready sees a fresh auth.checkedAt when it runs.
            // readiness-state.json is intentionally NOT refreshed here — no browser run
            // means no new sniper/modal data, so the readiness record should not be touched.
            console.log(
              `[auto-preflight] ${trigger.name} confirmed by HTTP ping ` +
              `(booking access confirmed, cache fresh) — skipping browser. ` +
              `confirmed-ready will refresh via ping.`
            );
            updateAuthState({ daxkoValid: true, familyworksValid: true, lastCheckedAt: Date.now() });
            updateLastSuccessfulPreflightAt();
            appendLog({
              timestamp:   firedAt,
              jobId:       dbJob.id,
              classTitle:  dbJob.class_title,
              triggerName: trigger.name,
              status:      'pass',
              message:     `Session + booking access confirmed via HTTP ping (cache fresh) — no browser launch needed`,
            });
            pingConfirmed = true;
          } else if (pingResult.trusted && currentAuthState.bookingAccessConfirmed && !cacheOk) {
            // Sessions and booking access confirmed but schedule cache is stale or missing.
            // Must run the browser so Playwright refreshes the schedule cache.
            console.log(`[auto-preflight] ${trigger.name} ping OK + booking confirmed but schedule cache is stale/absent — running browser to refresh.`);
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
          if (status === 'pass') updateLastSuccessfulPreflightAt();

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

        // ── Stage 4 — persist canonical confirmed-ready state ─────────────
        // Called unconditionally: fires after the ping fast-path AND after a
        // full browser run so the state file always reflects the latest evidence.
        // Stage 6: pass refreshSource so the file records what kind of validation
        // last wrote it — 'ping' means no Playwright ran; 'browser' means it did.
        refreshConfirmedReadyState({
          classTitle: dbJob.class_title,
          classTime:  dbJob.class_time,
          instructor: dbJob.instructor  || null,
          dayOfWeek:  dbJob.day_of_week,
          targetDate: dbJob.target_date || null,
        }, { source: pingConfirmed ? 'ping' : 'browser' });

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
