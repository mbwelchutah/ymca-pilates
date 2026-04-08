// Shared in-process auth mutex.
// Prevents concurrent Daxko/FamilyWorks auth attempts from launching
// multiple browser instances and writing conflicting state files.
//
// Usage:
//   const { acquireLock, releaseLock, isLocked, lockOwner } = require('./auth-lock');
//   if (!acquireLock('my-caller')) { /* blocked */ return; }
//   try { /* browser work */ } finally { releaseLock(); }
//
// The lock is held process-wide — a single Node.js server process is the
// expected runtime, so no IPC mechanism is needed.
//
// Stage 2: acquiring/releasing the lock automatically syncs
// isAuthInProgress in AuthState so the UI and API always reflect
// whether a browser auth operation is currently in flight.
//
// Stage 3: a watchdog timer fires if the lock is held longer than
// WATCHDOG_MS.  This force-releases the lock so isAuthInProgress never
// stays true indefinitely after a hung Playwright browser or network stall.

const { updateAuthState } = require('./auth-state');

const WATCHDOG_MS = 120_000; // 2 minutes — exceeds longest normal Playwright run

let _locked        = false;
let _lockOwner     = null;
let _watchdogTimer = null;

/**
 * Try to acquire the lock.
 * Sets isAuthInProgress = true in AuthState when successful.
 * Starts a watchdog that force-releases after WATCHDOG_MS.
 * @param {string} owner — human-readable caller label
 * @returns {boolean} true if lock was acquired, false if already held
 */
function acquireLock(owner) {
  if (_locked) return false;
  _locked    = true;
  _lockOwner = owner || 'unknown';
  console.log(`[auth-lock] Acquired by "${_lockOwner}"`);
  updateAuthState({ isAuthInProgress: true });

  // Stage 3: watchdog — if the lock is still held after WATCHDOG_MS, force-release.
  // This prevents isAuthInProgress from staying true forever when a Playwright
  // browser hangs, a network call stalls, or any other unresolved async path.
  _watchdogTimer = setTimeout(() => {
    if (_locked) {
      console.warn(
        `[auth-lock] Watchdog: lock held >${WATCHDOG_MS / 1000}s by "${_lockOwner}" — ` +
        `force-releasing to prevent stale isAuthInProgress.`
      );
      releaseLock();
    }
  }, WATCHDOG_MS);

  return true;
}

/**
 * Release the lock.
 * Clears the watchdog timer and sets isAuthInProgress = false in AuthState.
 * Safe to call when not held (no-op).
 */
function releaseLock() {
  if (!_locked) return;

  // Cancel watchdog before releasing so it doesn't double-fire.
  if (_watchdogTimer) {
    clearTimeout(_watchdogTimer);
    _watchdogTimer = null;
  }

  const prev = _lockOwner;
  _locked    = false;
  _lockOwner = null;
  console.log(`[auth-lock] Released by "${prev}"`);
  updateAuthState({ isAuthInProgress: false });
}

/** Returns true if the lock is currently held. */
function isLocked() { return _locked; }

/** Returns the current owner label, or null if not held. */
function lockOwner() { return _lockOwner; }

module.exports = { acquireLock, releaseLock, isLocked, lockOwner };
