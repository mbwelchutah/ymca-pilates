// Dedicated Daxko session check — login-only, no booking pipeline.
// Much faster than a full preflight: just launches browser, logs in,
// confirms auth, closes, and saves the result to session-status.json.
//
// This gives the user a trustworthy, timestamped answer to:
//   "Are my YMCA credentials working right now?"
// without triggering any booking attempt.

const fs   = require('fs');
const path = require('path');
const { createSession }   = require('./daxko-session');
const { saveCookies }     = require('./session-ping');
const { updateAuthState } = require('./auth-state');

const DATA_DIR    = path.resolve(__dirname, '../data');
const STATUS_FILE = path.join(DATA_DIR, 'session-status.json');

function saveStatus(status) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.warn('[session-check] saveStatus failed:', e.message);
  }
}

function loadStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// source: 'manual' | 'keepalive' | 'preflight'
async function runSessionCheck({ source = 'manual' } = {}) {
  const checkedAt = new Date().toISOString();
  let session = null;

  console.log(`[session-check] Starting dedicated login check (source: ${source})...`);

  try {
    session = await createSession({ headless: true, validateOnly: true });
    // If createSession() returned without throwing, auth succeeded.
    // For a full browser session, save cookies for the next Tier-2 ping.
    // For a fast-validated stub (_fastValidated), cookies are already saved
    // from the ping itself — skip re-saving to avoid overwriting with [].
    if (!session._fastValidated) {
      try {
        const allCookies = await session.page.context().cookies();
        saveCookies(allCookies);
      } catch (e) {
        console.warn('[session-check] Failed to save cookies for Tier-2 ping:', e.message);
      }
    }
    const screenshotRaw = await session.snap('session-check-pass');
    const screenshot = screenshotRaw ? path.basename(screenshotRaw) : null;
    const fastPath = session._fastValidated === true;
    const status = {
      valid:      true,
      checkedAt,
      source,
      detail:     fastPath
        ? 'Session valid — confirmed via HTTP ping (no browser needed)'
        : 'Login successful — credentials valid',
      screenshot,
    };
    saveStatus(status);
    updateAuthState({ daxkoValid: true, familyworksValid: true, lastCheckedAt: Date.now() });
    console.log('[session-check] Login succeeded — credentials valid.');
    return status;
  } catch (err) {
    // err.screenshotPath is set by daxko-session.js when login fails and a
    // screenshot was already captured before the error was thrown.
    const screenshot = err.screenshotPath ? path.basename(err.screenshotPath) : null;
    console.warn('[session-check] Login failed:', err.message);
    const status = {
      valid:      false,
      checkedAt,
      source,
      detail:     err.message || 'Login failed',
      screenshot,
    };
    saveStatus(status);
    updateAuthState({ daxkoValid: false, familyworksValid: false, lastCheckedAt: Date.now() });
    return status;
  } finally {
    if (session) {
      try { await session.close(); } catch (_) {}
    }
  }
}

module.exports = { runSessionCheck, loadStatus, saveStatus };
