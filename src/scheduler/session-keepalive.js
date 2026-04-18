// Session Keep-Alive / Reliability (Stage 9.3 / Stage 4 auth-arch)
//
// Periodically runs a lightweight session check to verify credentials are still
// valid and the YMCA auth system is reachable.  Runs silently in the background
// (default: every 12 minutes) while idle — no alerts, no modals.
//
// A keepalive failure is also recorded in the failures DB so the confidence
// score naturally penalises it without any extra wiring.
//
// Safe to call on every scheduler tick — it self-gates on interval + in-progress.

const fs   = require('fs');
const path = require('path');

const { writeJsonAtomic }             = require('../util/atomic-json');
const { runSessionCheck }             = require('../bot/session-check');
const { recordFailure }               = require('../db/failures');
const { getAllJobs }                   = require('../db/jobs');
const { refreshReadiness }            = require('../bot/readiness-state');
const { refreshConfirmedReadyState }  = require('../bot/confirmed-ready');
const { pingSessionHttp }             = require('../bot/session-ping');
const { isLocked }                    = require('../bot/auth-lock');
const { updateAuthState, getCanonicalAuthTruth } = require('../bot/auth-state');

const DATA_DIR      = path.resolve(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'session-keepalive-settings.json');
const LOG_FILE      = path.join(DATA_DIR, 'session-keepalive-log.json');

const DEFAULT_INTERVAL_MINUTES = 12;  // silent background check every 12 minutes
const TRUST_THRESHOLD_MIN      = 30;  // Tier-1: trust cached data within this window
const MAX_LOG_ENTRIES          = 20;

// ── In-memory guard ───────────────────────────────────────────────────────────
let running = false;

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { enabled: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES };
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Support legacy settings files that stored intervalHours.
    const legacyMinutes = typeof raw.intervalHours === 'number' && raw.intervalHours > 0
      ? Math.round(raw.intervalHours * 60)
      : null;
    return {
      enabled:         typeof raw.enabled === 'boolean' ? raw.enabled : true,
      intervalMinutes: typeof raw.intervalMinutes === 'number' && raw.intervalMinutes > 0
        ? raw.intervalMinutes
        : legacyMinutes ?? DEFAULT_INTERVAL_MINUTES,
    };
  } catch { return { enabled: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES }; }
}

function saveSettings(settings) {
  try {
    writeJsonAtomic(SETTINGS_FILE, settings);
  } catch (e) { console.warn('[session-keepalive] saveSettings failed:', e.message); }
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
    if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
    writeJsonAtomic(LOG_FILE, entries);
  } catch (e) { console.warn('[session-keepalive] appendLog failed:', e.message); }
}

// ── Timing helpers ────────────────────────────────────────────────────────────

function getLastRunTime() {
  const entries = loadLog();
  if (entries.length === 0) return null;
  return new Date(entries[entries.length - 1].timestamp).getTime();
}

// Returns ms until the next keepalive is due (negative = overdue).
function getMsUntilNext(settings) {
  const lastMs = getLastRunTime();
  if (lastMs === null) return 0; // never run → due immediately
  const intervalMs = settings.intervalMinutes * 60 * 1000;
  return lastMs + intervalMs - Date.now();
}

// Returns info shown in the UI config endpoint.
function getNextKeepaliveInfo() {
  const settings = loadSettings();
  if (!settings.enabled) return null;
  const ms = getMsUntilNext(settings);
  // Return both units for forward/backward client compatibility.
  return {
    msUntil:         Math.max(0, ms),
    intervalMinutes: settings.intervalMinutes,
    intervalHours:   Math.round(settings.intervalMinutes / 60),
  };
}

// ── Tier-1: File-freshness check ─────────────────────────────────────────────
//
// Stage 9 (auth-truth-unification): migrated from reading session-status.json
// + familyworks-session.json directly to getCanonicalAuthTruth() (auth-state.json).
//
// auth-state.json.lastCheckedAt is a single unified ms timestamp updated by
// every successful validation tier (HTTP ping, Playwright, startup ping) for
// both Daxko and FamilyWorks.  Using it as the freshness gate is strictly more
// accurate than the previous per-file age approach:
//   - A successful HTTP ping updates lastCheckedAt even though session-status.json
//     is only written by Playwright (Tier-3), so the old Tier-1 gate would
//     incorrectly miss the cache after a ping-trusted check.
//   - A single unified timestamp removes the separate Daxko/FW age comparison.
//
// Returns { trusted: boolean, detail: string }.

function checkFreshness(thresholdMs = TRUST_THRESHOLD_MIN * 60 * 1000) {
  try {
    const now           = Date.now();
    const canonicalAuth = getCanonicalAuthTruth();

    // ── Validity check ───────────────────────────────────────────────────────
    if (canonicalAuth.sessionValid !== true) {
      return { trusted: false, detail: 'Daxko session not confirmed valid — running full check' };
    }
    if (canonicalAuth.fwStatusCode !== 'FAMILYWORKS_READY') {
      return { trusted: false, detail: `FamilyWorks session not ready (${canonicalAuth.fwStatusCode}) — running full check` };
    }

    // ── Freshness check (single unified timestamp) ───────────────────────────
    if (canonicalAuth.lastCheckedAt == null) {
      return { trusted: false, detail: 'No prior validation timestamp — running full check' };
    }
    const ageMs = now - canonicalAuth.lastCheckedAt;
    if (!Number.isFinite(ageMs)) {
      return { trusted: false, detail: 'Invalid validation timestamp — running full check' };
    }
    if (ageMs > thresholdMs) {
      return { trusted: false, detail: `Session data stale (${Math.round(ageMs / 60000)}m since last validation) — running full check` };
    }

    return {
      trusted: true,
      detail:  `Session data fresh — last validated ${Math.round(ageMs / 60000)}m ago (threshold ${TRUST_THRESHOLD_MIN}m)`,
    };
  } catch (err) {
    return { trusted: false, detail: `Freshness check error: ${err.message}` };
  }
}

// ── Main check ────────────────────────────────────────────────────────────────

async function checkSessionKeepalive({ isActive = false } = {}) {
  const settings = loadSettings();
  if (!settings.enabled) return;

  // Don't run if the real booking bot is active.
  if (isActive) {
    console.log('[session-keepalive] Skipping — booking job active.');
    return;
  }

  // Don't run if not yet due.
  if (getMsUntilNext(settings) > 0) return;

  // Don't overlap with another keepalive already in flight.
  if (running) {
    console.log('[session-keepalive] Skipping — already running.');
    return;
  }

  // Stage 4: Single auth lane — skip if a booking run, settings login, or
  // another session check already holds the auth lock.  runSessionCheck() also
  // guards itself, but checking here avoids even the Tier-1 freshness work and
  // makes the skip reason visible in the server log.
  if (isLocked()) {
    console.log('[session-keepalive] Skipping — auth lock held by concurrent operation.');
    return;
  }

  running = true;
  const timestamp = new Date().toISOString();

  // ── Tier 1: File-freshness short-circuit ─────────────────────────────────
  // If both session files are recent and valid, skip the Playwright launch.
  // Records a trust log entry so "Last check" in the UI stays current.
  const freshness = checkFreshness();
  if (freshness.trusted) {
    console.log('[session-keepalive] Tier 1 trust —', freshness.detail);
    appendLog({ timestamp, valid: true, detail: freshness.detail, screenshot: null, tier: 1 });
    // Bump lastCheckedAt so the UI "Checked X ago" stays current even when
    // Tier-1 is confirming trust without launching a browser.
    updateAuthState({ daxkoValid: true, familyworksValid: true, lastCheckedAt: Date.now() });
    try {
      const jobs   = getAllJobs().filter(j => j.is_active === 1);
      const topJob = jobs[0] ?? null;
      // Refresh confirmed-ready before readiness (write-order invariant).
      // source:'ping' is honest — only file freshness was checked, no network request made.
      refreshConfirmedReadyState(
        topJob ? { classTitle: topJob.class_title, dayOfWeek: topJob.day_of_week ?? null,
                   classTime: topJob.class_time ?? null, instructor: topJob.instructor ?? null,
                   targetDate: topJob.target_date ?? null } : null,
        { source: 'ping' }
      );
      refreshReadiness({ jobId: topJob?.id ?? null, classTitle: topJob?.class_title ?? null, source: 'keepalive' });
    } catch (_) { /* non-fatal */ }
    running = false;
    return;
  }

  // Tier 1 missed — log the reason and try Tier-2 HTTP ping before Playwright.
  console.log('[session-keepalive] Tier 1 miss —', freshness.detail);

  // ── Tier 2: HTTP ping ─────────────────────────────────────────────────────
  // Uses saved browser cookies to make a fast authenticated HTTP request to
  // Daxko and FamilyWorks.  Skips Playwright entirely on success.
  const pingResult = await pingSessionHttp();
  if (pingResult.trusted) {
    console.log('[session-keepalive] Tier 2 trust —', pingResult.detail);
    appendLog({ timestamp, valid: true, detail: pingResult.detail, screenshot: null, tier: 2 });
    // Clear stale SESSION_EXPIRED / SNIPER_BLOCKED_AUTH from sniper state so
    // the card and preflight loop both recover when HTTP ping confirms session valid.
    try {
      const sniperPath = path.join(DATA_DIR, 'sniper-state.json');
      if (fs.existsSync(sniperPath)) {
        const sniper = JSON.parse(fs.readFileSync(sniperPath, 'utf8'));
        let changed = false;
        if (sniper.bundle?.session === 'SESSION_EXPIRED' || sniper.bundle?.session === 'SESSION_REQUIRED') {
          sniper.bundle.session = 'SESSION_UNKNOWN';
          changed = true;
        }
        if (sniper.sniperState === 'SNIPER_BLOCKED_AUTH') {
          sniper.sniperState   = 'SNIPER_WAITING';
          sniper.authBlockedAt = null;
          changed = true;
        }
        if (changed) {
          sniper.updatedAt = new Date().toISOString();
          writeJsonAtomic(sniperPath, sniper);
          console.log('[session-keepalive] Tier 2: cleared stale auth-block from sniper state (session confirmed via HTTP ping).');
        }
      }
    } catch (_) { /* non-fatal */ }
    try {
      const jobs   = getAllJobs().filter(j => j.is_active === 1);
      const topJob = jobs[0] ?? null;
      // Refresh confirmed-ready before readiness (write-order invariant).
      // source:'ping' — an actual HTTP ping to Daxko + FamilyWorks succeeded.
      refreshConfirmedReadyState(
        topJob ? { classTitle: topJob.class_title, dayOfWeek: topJob.day_of_week ?? null,
                   classTime: topJob.class_time ?? null, instructor: topJob.instructor ?? null,
                   targetDate: topJob.target_date ?? null } : null,
        { source: 'ping' }
      );
      refreshReadiness({ jobId: topJob?.id ?? null, classTitle: topJob?.class_title ?? null, source: 'keepalive' });
    } catch (_) { /* non-fatal */ }
    running = false;
    return;
  }

  console.log('[session-keepalive] Tier 2 miss —', pingResult.detail);
  console.log('[session-keepalive] Running full Playwright session check (Tier 3)...');

  try {
    const result = await runSessionCheck({ source: 'keepalive' });

    const entry = {
      timestamp,
      valid:      result.valid,
      detail:     result.detail,
      screenshot: result.screenshot ?? null,
      tier:       3,
    };
    appendLog(entry);

    // Stage 9B — refresh normalized readiness after every keepalive check.
    // Also refresh confirmed-ready (write-order invariant: confirmed-ready first).
    // source:'browser' — Playwright ran and session-check result is now on disk.
    try {
      const jobs    = getAllJobs().filter(j => j.is_active === 1);
      const topJob  = jobs[0] ?? null;
      refreshConfirmedReadyState(
        topJob ? { classTitle: topJob.class_title, dayOfWeek: topJob.day_of_week ?? null,
                   classTime: topJob.class_time ?? null, instructor: topJob.instructor ?? null,
                   targetDate: topJob.target_date ?? null } : null,
        { source: 'browser' }
      );
      refreshReadiness({ jobId: topJob?.id ?? null, classTitle: topJob?.class_title ?? null, source: 'keepalive' });
    } catch (_) { /* non-fatal */ }

    if (!result.valid) {
      // Record in the failures DB so the confidence score is penalised.
      const jobs = getAllJobs().filter(j => j.is_active === 1);
      const jobId = jobs.length > 0 ? jobs[0].id : null;
      recordFailure({
        jobId,
        phase:      'auth',
        reason:     'session_invalid',
        message:    result.detail || 'Session keep-alive check failed',
        classTitle: jobs.length > 0 ? jobs[0].class_title : null,
        screenshot: result.screenshot ?? null,
        category:   'auth',
        label:      'Session keep-alive failed',
        context:    { source: 'keepalive', checkedAt: result.checkedAt },
      });
      console.warn('[session-keepalive] Session INVALID —', result.detail);
    } else {
      console.log('[session-keepalive] Session valid — credentials OK.');
    }
  } catch (err) {
    console.error('[session-keepalive] Unexpected error:', err.message);
    appendLog({ timestamp, valid: false, detail: err.message, screenshot: null, tier: 3 });
  } finally {
    running = false;
  }
}

// ── Config helpers for API ────────────────────────────────────────────────────

function getKeepaliveConfig() {
  const settings = loadSettings();
  const entries  = loadLog();
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const next     = getNextKeepaliveInfo();
  // Return both units for forward/backward client compatibility.
  return {
    enabled:               settings.enabled,
    intervalMinutes:       settings.intervalMinutes,
    intervalHours:         Math.round(settings.intervalMinutes / 60),
    trustThresholdMinutes: TRUST_THRESHOLD_MIN,
    lastRun:               lastEntry,
    next,
  };
}

module.exports = {
  checkSessionKeepalive,
  checkFreshness,
  loadSettings,
  saveSettings,
  getKeepaliveConfig,
};
