// Single source of truth for authentication state.
// Persists to src/data/auth-state.json and is the canonical record
// for all downstream consumers (API, UI, preflight, booking).
//
// AuthState shape:
//   status                  'connected' | 'needs_refresh' | 'recovering' | 'signed_out'
//   daxkoValid              boolean   — Daxko session confirmed valid via HTTP or Playwright
//   familyworksValid        boolean   — FamilyWorks session confirmed valid
//   bookingAccessConfirmed  boolean   — schedule embed loaded + Reserve/Waitlist button confirmed
//   bookingAccessConfirmedAt number|null — ms timestamp when booking access was last confirmed
//                                         null = never confirmed or session was lost
//   lastCheckedAt           number|null — ms timestamp of last any-tier session validation
//   lastRecoveredAt         number|null — ms timestamp of last full Playwright re-login
//   isAuthInProgress        boolean   — login/recovery is currently in flight

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'auth-state.json');

const DEFAULT_STATE = {
  status:                   'signed_out',
  daxkoValid:               false,
  familyworksValid:         false,
  bookingAccessConfirmed:   false,
  bookingAccessConfirmedAt: null,   // ms epoch — null until first modal confirmation
  lastCheckedAt:            null,
  lastRecoveredAt:          null,
  isAuthInProgress:         false,
};

// ── File I/O ─────────────────────────────────────────────────────────────────

function _read() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function _write(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[auth-state] write failed:', e.message);
  }
}

// ── Legacy migration ──────────────────────────────────────────────────────────
// On first run (no auth-state.json yet), bootstrap from existing session files
// so existing users don't see a false "signed_out" state.

function _deriveFromLegacy() {
  const STATUS_FILE = path.join(DATA_DIR, 'session-status.json');
  const FW_FILE     = path.join(DATA_DIR, 'familyworks-session.json');

  let daxkoValid       = false;
  let familyworksValid = false;
  let lastCheckedAt    = null;

  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      daxkoValid = raw.valid === true;
      if (raw.checkedAt) {
        const t = new Date(raw.checkedAt).getTime();
        if (Number.isFinite(t)) lastCheckedAt = Math.max(lastCheckedAt ?? 0, t);
      }
    }
  } catch {}

  try {
    if (fs.existsSync(FW_FILE)) {
      const raw = JSON.parse(fs.readFileSync(FW_FILE, 'utf8'));
      familyworksValid = raw.ready === true || raw.status === 'FAMILYWORKS_READY';
      if (raw.checkedAt) {
        const t = new Date(raw.checkedAt).getTime();
        if (Number.isFinite(t)) lastCheckedAt = Math.max(lastCheckedAt ?? 0, t);
      }
    }
  } catch {}

  let status = 'signed_out';
  if (daxkoValid && familyworksValid) status = 'connected';
  else if (daxkoValid || familyworksValid) status = 'needs_refresh';

  return { ...DEFAULT_STATE, status, daxkoValid, familyworksValid, lastCheckedAt };
}

// ── Derive status from validity flags ─────────────────────────────────────────

function _deriveStatus(state) {
  if (state.isAuthInProgress)                          return 'recovering';
  if (state.daxkoValid && state.familyworksValid)      return 'connected';
  if (!state.daxkoValid && !state.familyworksValid &&
      state.lastCheckedAt === null)                    return 'signed_out';
  return 'needs_refresh';
}

// ── Field migrations ──────────────────────────────────────────────────────────
// Applied on read; persisted so subsequent reads are clean.

function _migrate(stored) {
  let changed = false;

  // bookingSurfaceValid was renamed to bookingAccessConfirmed.
  if ('bookingSurfaceValid' in stored && !('bookingAccessConfirmed' in stored)) {
    stored.bookingAccessConfirmed = stored.bookingSurfaceValid;
    delete stored.bookingSurfaceValid;
    changed = true;
  }

  // bookingAccessConfirmedAt was added in Stage 3.
  // If booking access was already confirmed, use lastRecoveredAt as a best-effort
  // timestamp (the last full session run is when it would have been confirmed).
  // Otherwise default to null (never checked).
  if (!('bookingAccessConfirmedAt' in stored)) {
    stored.bookingAccessConfirmedAt = stored.bookingAccessConfirmed
      ? (stored.lastRecoveredAt ?? stored.lastCheckedAt ?? null)
      : null;
    changed = true;
  }

  if (changed) _write(stored);
  return stored;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the current AuthState.
 * Seeds from legacy session files on first run so existing state isn't lost.
 */
function getAuthState() {
  const stored = _read();
  if (stored) return { ...DEFAULT_STATE, ..._migrate(stored) };

  // First run — bootstrap from legacy files and persist.
  const derived = _deriveFromLegacy();
  _write(derived);
  console.log('[auth-state] Bootstrapped from legacy session files:', derived.status);
  return derived;
}

/**
 * Merge a patch into the current AuthState and persist.
 * Automatically re-derives `status` unless explicitly supplied in the patch.
 *
 * @param {Partial<typeof DEFAULT_STATE>} patch
 * @returns {typeof DEFAULT_STATE} the updated state
 */
function updateAuthState(patch) {
  const current = getAuthState();
  const next    = { ...current, ...patch };

  if (!('status' in patch)) {
    next.status = _deriveStatus(next);
  }

  _write(next);
  return next;
}

/**
 * Hard-reset to DEFAULT_STATE (used by sign-out).
 */
function clearAuthState() {
  const cleared = { ...DEFAULT_STATE, status: 'signed_out' };
  _write(cleared);
  return cleared;
}

module.exports = { getAuthState, updateAuthState, clearAuthState, DEFAULT_STATE };
