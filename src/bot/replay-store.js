/**
 * Sniper Replay Store (Stage 2)
 *
 * Captures human-readable replay events during each booking attempt.
 * Observer-only — no booking logic lives here.
 *
 * Lifecycle per run:
 *   startRun(jobId, runId)      — initialise (called at start of runBookingJob)
 *   addEvent(jobId, type, label, detail?) — append an event (called at capture points)
 *   finishRun(jobId, outcome)   — persist to disk (called via logRunSummary)
 *   getLastReplay(jobId)        — fetch last completed replay (called by API)
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data/replays');

// ── In-memory store — last summary per jobId (survives the function call) ─────
const _active = new Map();  // jobId → current (in-progress) ReplaySummary

// ── startRun ──────────────────────────────────────────────────────────────────
function startRun(jobId, runId) {
  const summary = {
    jobId:      String(jobId),
    runId,
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
  const event = {
    timestamp: new Date().toISOString(),
    type,
    label,
  };
  if (detail != null) event.detail = String(detail);
  summary.events.push(event);
}

// ── finishRun ─────────────────────────────────────────────────────────────────
function finishRun(jobId, outcome) {
  const summary = _active.get(String(jobId));
  if (!summary) return;
  summary.outcome    = outcome || 'unknown';
  summary.capturedAt = new Date().toISOString();

  // Persist to disk so replays survive server restarts.
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `replay-${jobId}.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  } catch (e) {
    console.warn('[replay-store] persist failed:', e.message);
  }
}

// ── getLastReplay ─────────────────────────────────────────────────────────────
// Returns the last finished replay for a job, or null if none exists.
function getLastReplay(jobId) {
  // Check in-memory first (finished runs have capturedAt set)
  const mem = _active.get(String(jobId));
  if (mem && mem.capturedAt) return mem;

  // Fall back to disk
  try {
    const file = path.join(DATA_DIR, `replay-${jobId}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.warn('[replay-store] load failed:', e.message);
  }
  return null;
}

module.exports = { startRun, addEvent, finishRun, getLastReplay };
