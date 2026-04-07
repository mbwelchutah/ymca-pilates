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

const { runSessionCheck }  = require('../bot/session-check');
const { recordFailure }    = require('../db/failures');
const { getAllJobs }        = require('../db/jobs');
const { refreshReadiness } = require('../bot/readiness-state');

const DATA_DIR      = path.resolve(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'session-keepalive-settings.json');
const LOG_FILE      = path.join(DATA_DIR, 'session-keepalive-log.json');

const DEFAULT_INTERVAL_MINUTES = 12;  // silent background check every 12 minutes
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
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    let entries = loadLog();
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
    fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
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
  return { msUntil: Math.max(0, ms), intervalMinutes: settings.intervalMinutes };
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

  running = true;
  const timestamp = new Date().toISOString();
  console.log('[session-keepalive] Running periodic session check...');

  try {
    const result = await runSessionCheck({ source: 'keepalive' });

    const entry = {
      timestamp,
      valid:      result.valid,
      detail:     result.detail,
      screenshot: result.screenshot ?? null,
    };
    appendLog(entry);

    // Stage 9B — refresh normalized readiness after every keepalive check.
    try {
      const jobs    = getAllJobs().filter(j => j.is_active === 1);
      const topJob  = jobs[0] ?? null;
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
    appendLog({ timestamp, valid: false, detail: err.message, screenshot: null });
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
  return { enabled: settings.enabled, intervalMinutes: settings.intervalMinutes, lastRun: lastEntry, next };
}

module.exports = {
  checkSessionKeepalive,
  loadSettings,
  saveSettings,
  getKeepaliveConfig,
};
