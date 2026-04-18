/**
 * Persistence layer for the ConnectionHealth record (STAGE 3).
 *
 * Single small JSON file at data/connection-health.json, written atomically
 * via the existing util.  No DB column, no migration, no schema change.
 *
 * Isolated:
 *   - Only this module reads/writes the file.
 *   - No imports from src/scheduler, src/bot, src/web.
 *   - No timers, no side-effects beyond load/save.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { writeJsonAtomic }                  = require('../util/atomic-json');
const { emptyHealth, withDerivedState }    = require('./connection-health');

const DATA_DIR    = path.resolve(__dirname, '../data');
const HEALTH_FILE = path.join(DATA_DIR, 'connection-health.json');

let _cache = null;       // last loaded record (in-memory; file is source of truth)

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch { /* best-effort */ }
}

/**
 * Load the current ConnectionHealth record from disk.  Returns a fresh
 * `emptyHealth()` record if the file is missing or unreadable — never throws.
 */
function loadHealth() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) {
      _cache = emptyHealth();
      return { ..._cache };
    }
    const raw = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    // Defensive merge so missing fields fall back to defaults.
    _cache = { ...emptyHealth(), ...raw };
    return { ..._cache };
  } catch {
    _cache = emptyHealth();
    return { ..._cache };
  }
}

/**
 * Save a ConnectionHealth record atomically.  Pure write — caller is
 * responsible for having already merged in the new fields.
 */
function saveHealth(record) {
  ensureDataDir();
  const next = { ...emptyHealth(), ...record };
  writeJsonAtomic(HEALTH_FILE, next);
  _cache = next;
  return { ...next };
}

/**
 * Read-modify-write helper.  `mutator` receives a copy of the current record
 * and returns the patched record (or a partial patch object).  After mutation,
 * `currentState` is recomputed from `withDerivedState(...)` UNLESS the patch
 * explicitly sets a non-null `currentState` of its own.
 *
 * Keeps callers from accidentally racing on the JSON file.
 *
 * @param {(h: object) => object} mutator
 * @param {?number}               msUntilOpen  for state recomputation
 * @returns {object} the saved record
 */
function updateHealth(mutator, msUntilOpen = null) {
  const current = loadHealth();
  const patched = { ...current, ...(mutator(current) || {}) };
  // Re-derive state unless the patch hard-overrides it.
  const explicit = patched.currentState && patched.currentState !== current.currentState;
  const next     = explicit ? patched : withDerivedState(patched, msUntilOpen);
  return saveHealth(next);
}

/** Path is exported for tests that want to inspect / clean up the file. */
module.exports = {
  HEALTH_FILE,
  loadHealth,
  saveHealth,
  updateHealth,
};
