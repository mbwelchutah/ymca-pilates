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

let _locked    = false;
let _lockOwner = null;

/**
 * Try to acquire the lock.
 * @param {string} owner — human-readable caller label
 * @returns {boolean} true if lock was acquired, false if already held
 */
function acquireLock(owner) {
  if (_locked) return false;
  _locked    = true;
  _lockOwner = owner || 'unknown';
  console.log(`[auth-lock] Acquired by "${_lockOwner}"`);
  return true;
}

/** Release the lock. Safe to call when not held (no-op). */
function releaseLock() {
  if (!_locked) return;
  const prev = _lockOwner;
  _locked    = false;
  _lockOwner = null;
  console.log(`[auth-lock] Released by "${prev}"`);
}

/** Returns true if the lock is currently held. */
function isLocked() { return _locked; }

/** Returns the current owner label, or null if not held. */
function lockOwner() { return _lockOwner; }

module.exports = { acquireLock, releaseLock, isLocked, lockOwner };
