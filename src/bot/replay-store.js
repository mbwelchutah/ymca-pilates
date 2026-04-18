/**
 * Sniper Replay Store (Stage 2 + Stage 6)
 *
 * Captures human-readable replay events during each booking attempt.
 * Observer-only — no booking logic lives here.
 *
 * Each completed run is written to its own file:
 *   replay-{jobId}-{safeRunId}.json
 *
 * A per-job index file tracks the last MAX_RUNS entries:
 *   replay-{jobId}-index.json → { jobId, runs: [{ runId, outcome, capturedAt, eventCount }] }
 *
 * Lifecycle per run:
 *   startRun(jobId, runId)               — initialise (called at start of runBookingJob)
 *   addEvent(jobId, type, label, detail?) — append an event (called at capture points)
 *   finishRun(jobId, outcome)            — persist to disk (called via logRunSummary)
 *   getLastReplay(jobId)                 — fetch last completed replay (called by API)
 *   getReplayList(jobId)                 — fetch index metadata array
 *   getReplayById(jobId, runId)          — fetch a specific past run
 */

const fs   = require('fs');
const path = require('path');

const { writeJsonAtomic } = require('../util/atomic-json');

const DATA_DIR  = path.resolve(__dirname, '../data/replays');
const MAX_RUNS  = 10;

// ── In-memory store — current (in-progress) run per jobId ─────────────────────
const _active = new Map();

// ── File path helpers ─────────────────────────────────────────────────────────

/** Sanitise an ISO runId to a safe filename segment. */
function _safe(runId) {
  return String(runId).replace(/[^a-zA-Z0-9-]/g, '_');
}

function _runFile(jobId, runId) {
  return path.join(DATA_DIR, `replay-${jobId}-${_safe(runId)}.json`);
}

function _indexFile(jobId) {
  return path.join(DATA_DIR, `replay-${jobId}-index.json`);
}

// ── Index helpers ─────────────────────────────────────────────────────────────

function _loadIndex(jobId) {
  try {
    const f = _indexFile(jobId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return { jobId: String(jobId), runs: [] };
}

function _saveIndex(jobId, index) {
  try {
    writeJsonAtomic(_indexFile(jobId), index);
  } catch (e) {
    console.warn('[replay-store] index write failed:', e.message);
  }
}

// ── startRun ──────────────────────────────────────────────────────────────────
function startRun(jobId, runId) {
  const summary = {
    jobId:      String(jobId),
    runId:      String(runId),
    outcome:    'unknown',
    events:     [],
    capturedAt: null,
  };
  _active.set(String(jobId), summary);
}

// ── addEvent ──────────────────────────────────────────────────────────────────
function addEvent(jobId, type, label, detail) {
  const summary = _active.get(String(jobId));
  if (!summary) return;
  const event = { timestamp: new Date().toISOString(), type, label };
  if (detail != null) event.detail = String(detail);
  summary.events.push(event);
}

// ── finishRun ─────────────────────────────────────────────────────────────────
function finishRun(jobId, outcome) {
  const summary = _active.get(String(jobId));
  if (!summary) return;
  summary.outcome    = outcome || 'unknown';
  summary.capturedAt = new Date().toISOString();

  try {
    // 1. Write the individual run file
    writeJsonAtomic(_runFile(jobId, summary.runId), summary);

    // 2. Update the per-job index (newest first, capped at MAX_RUNS)
    const index = _loadIndex(jobId);
    // Remove any prior entry with the same runId (idempotent)
    index.runs = index.runs.filter(r => r.runId !== summary.runId);
    index.runs.unshift({
      runId:      summary.runId,
      outcome:    summary.outcome,
      capturedAt: summary.capturedAt,
      eventCount: summary.events.length,
    });
    if (index.runs.length > MAX_RUNS) {
      const evicted = index.runs.splice(MAX_RUNS);
      // Best-effort delete orphaned run files
      for (const r of evicted) {
        try { fs.unlinkSync(_runFile(jobId, r.runId)); } catch {}
      }
    }
    _saveIndex(jobId, index);

    // 3. Keep the legacy single-file alias so old in-memory reads still work
    const legacyFile = path.join(DATA_DIR, `replay-${jobId}.json`);
    writeJsonAtomic(legacyFile, summary);

  } catch (e) {
    console.warn('[replay-store] persist failed:', e.message);
  }
}

// ── getLastReplay ─────────────────────────────────────────────────────────────
// Returns the most recent finished replay for a job, or null if none exists.
function getLastReplay(jobId) {
  // In-memory first (finished run has capturedAt set)
  const mem = _active.get(String(jobId));
  if (mem && mem.capturedAt) return mem;

  // Index: load most recent runId and read its file
  const index = _loadIndex(jobId);
  if (index.runs.length > 0) {
    const latest = index.runs[0];
    const file = _runFile(jobId, latest.runId);
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }

  // Legacy fallback (pre-Stage-6 single file)
  try {
    const legacyFile = path.join(DATA_DIR, `replay-${jobId}.json`);
    if (fs.existsSync(legacyFile)) return JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch {}

  return null;
}

// ── getReplayList ─────────────────────────────────────────────────────────────
// Returns metadata for all stored runs, newest first.
// Each entry: { runId, outcome, capturedAt, eventCount }
function getReplayList(jobId) {
  return _loadIndex(jobId).runs;
}

// ── getReplayById ─────────────────────────────────────────────────────────────
// Returns a specific past run by runId, or null if not found.
function getReplayById(jobId, runId) {
  try {
    const file = _runFile(jobId, runId);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[replay-store] getReplayById failed:', e.message);
  }
  return null;
}

module.exports = { startRun, addEvent, finishRun, getLastReplay, getReplayList, getReplayById };
