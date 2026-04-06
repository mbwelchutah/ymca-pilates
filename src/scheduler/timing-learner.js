// Stage 10F — Learned timing adjustments
//
// Records observations of when the booking action first becomes available
// relative to the expected opensAt, and derives small offset corrections to
// the execution-timing warmup/armed windows.
//
// ── Observation model ─────────────────────────────────────────────────────────
//
//   offset = observedReadyAtMs − expectedOpensAtMs
//
//   Negative (−30 000): action opened 30 s before the computed window → arm earlier
//   Positive (+45 000): action opened 45 s after the computed window  → arm later
//
// ── Adjustment logic ─────────────────────────────────────────────────────────
//
//   learnedOffsetMs   = median(last N offsets)
//   adjustedArmedMs   = max(0, ARMED_OFFSET_MS  − learnedOffsetMs)
//   adjustedWarmupMs  = max(0, WARMUP_OFFSET_MS − learnedOffsetMs)
//
//   Example: learnedOffset = −30 s (opens 30 s early)
//     → adjustedArmedMs  = 45 s − (−30 s) = 75 s  → arm 75 s before computed open
//       (= 45 s before actual open — the intended firing window)
//
// ── Persistence ───────────────────────────────────────────────────────────────
//
//   src/data/timing-learner.json — keyed by jobId string
//   {
//     "<jobId>": {
//       classTitle:   string,
//       observations: [{ offsetMs: number, recordedAt: ISO }]
//     }
//   }
//
// Log prefix: [timing-learner]

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.resolve(__dirname, '../data');
const LEARNER_FILE = path.join(DATA_DIR, 'timing-learner.json');

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_OBS       = 10;              // keep last N observations per job
const MIN_OBS       = 3;              // min observations required before applying offsets
const MAX_OFFSET_MS = 5 * 60 * 1000; // cap at ±5 min — reject obvious outliers

// ── File helpers ──────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (!fs.existsSync(LEARNER_FILE)) return {};
    return JSON.parse(fs.readFileSync(LEARNER_FILE, 'utf8'));
  } catch { return {}; }
}

function saveData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEARNER_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[timing-learner] saveData failed:', e.message);
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a timing observation — call when ACTION_READY is first detected
 * (burst:ready) so we capture when the actual open moment relative to the
 * computed opensAt.
 *
 * @param {number} jobId
 * @param {{ expectedOpensAtMs: number, observedReadyAtMs: number, classTitle: string }} opts
 */
function recordObservation(jobId, { expectedOpensAtMs, observedReadyAtMs, classTitle }) {
  const offset = observedReadyAtMs - expectedOpensAtMs;

  // Reject observations that fall outside the plausible ±5-min window.
  if (Math.abs(offset) > MAX_OFFSET_MS) {
    console.log(
      `[timing-learner] skip — Job #${jobId} offset ${Math.round(offset / 1000)}s ` +
      `exceeds ±${MAX_OFFSET_MS / 60000} min cap; ignoring.`
    );
    return;
  }

  const data = loadData();
  const key  = String(jobId);
  if (!data[key]) data[key] = { classTitle: classTitle ?? null, observations: [] };
  data[key].classTitle = classTitle ?? data[key].classTitle;

  data[key].observations.push({
    offsetMs:   offset,
    recordedAt: new Date().toISOString(),
  });

  // Rolling window — drop oldest when over cap.
  if (data[key].observations.length > MAX_OBS) {
    data[key].observations = data[key].observations.slice(-MAX_OBS);
  }

  saveData(data);

  const dir = offset < 0 ? 'early' : 'late';
  console.log(
    `[timing-learner] record — Job #${jobId} (${classTitle ?? '?'}) ` +
    `offset=${Math.round(offset / 1000)}s (${dir}) ` +
    `n=${data[key].observations.length}/${MAX_OBS}.`
  );
}

/**
 * Compute the learned median offset for a job and derive adjusted timing
 * overrides that the caller can pass into computeExecutionTiming().
 *
 * Returns null when there are fewer than MIN_OBS observations.
 *
 * @param {number} jobId
 * @param {{ WARMUP_OFFSET_MS: number, ARMED_OFFSET_MS: number }} baseOffsets
 * @returns {{
 *   learnedOffsetMs:      number,
 *   adjustedArmedOffsetMs:  number,
 *   adjustedWarmupOffsetMs: number,
 *   observationCount:     number,
 * } | null}
 */
function getLearnedOffsets(jobId, { WARMUP_OFFSET_MS, ARMED_OFFSET_MS }) {
  const data  = loadData();
  const key   = String(jobId);
  const entry = data[key];
  if (!entry || entry.observations.length < MIN_OBS) return null;

  const offsets        = entry.observations.map(o => o.offsetMs);
  const learnedOffsetMs = median(offsets);

  // Ensure adjusted offsets are non-negative.
  const adjustedArmedOffsetMs  = Math.max(0, ARMED_OFFSET_MS  - learnedOffsetMs);
  const adjustedWarmupOffsetMs = Math.max(0, WARMUP_OFFSET_MS - learnedOffsetMs);

  return {
    learnedOffsetMs,
    adjustedArmedOffsetMs,
    adjustedWarmupOffsetMs,
    observationCount: offsets.length,
  };
}

/**
 * Return a summary of all learned timing data (for API / diagnostics).
 *
 * @returns {Array<{ jobId, classTitle, observationCount, medianOffsetMs, lastRecordedAt }>}
 */
function loadLearnerSummary() {
  const data = loadData();
  return Object.entries(data).map(([jobId, entry]) => {
    const offsets = (entry.observations ?? []).map(o => o.offsetMs);
    return {
      jobId:            Number(jobId),
      classTitle:       entry.classTitle ?? null,
      observationCount: offsets.length,
      medianOffsetMs:   offsets.length ? median(offsets) : null,
      lastRecordedAt:   entry.observations?.at(-1)?.recordedAt ?? null,
    };
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { recordObservation, getLearnedOffsets, loadLearnerSummary };
