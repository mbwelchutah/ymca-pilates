// Stage 10F — Learned timing adjustments
//
// Records two independent classes of timing observations per job and derives
// offset corrections to the execution-timing warmup/armed windows.
//
// ── Class 1: Window-open offset observations (original Stage 10F) ─────────────
//
//   offset = observedReadyAtMs − expectedOpensAtMs
//
//   Negative (−30 000): action opened 30 s before the computed window → arm earlier
//   Positive (+45 000): action opened 45 s after the computed window  → arm later
//
//   learnedOffsetMs   = median(last N offsets)
//   adjustedArmedMs   = max(0, ARMED_OFFSET_MS  − learnedOffsetMs)
//   adjustedWarmupMs  = max(0, WARMUP_OFFSET_MS − learnedOffsetMs)
//
// ── Class 2: Run-speed observations (Stage 5) ─────────────────────────────────
//
//   Records how long each bot run takes from run_start to class-discovered,
//   broken into three phases: auth, page-load, class-discovery.
//
//   neededLeadTimeMs = median(totalMs) + LEAD_TIME_BUFFER_MS
//
//   This is the minimum armed-offset required so that a bot launched exactly
//   at armedAt will have finished page load and class discovery before the
//   booking window opens.
//
//   If neededLeadTimeMs > current armedOffset, the burst activation logic in
//   preflight-loop.js will extend the armed offset so the bot arms earlier.
//
// ── Persistence ───────────────────────────────────────────────────────────────
//
//   src/data/timing-learner.json — keyed by jobId string
//   {
//     "<jobId>": {
//       classTitle:   string,
//       observations: [{ offsetMs: number, recordedAt: ISO }],   // Class 1
//       runSpeeds:    [{ authMs, pageLoadMs, discoveryMs, recordedAt }]  // Class 2
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

const MAX_OBS       = 10;              // keep last N window-offset observations per job
const MIN_OBS       = 3;              // min observations required before applying learned offsets
const MAX_OFFSET_MS = 5 * 60 * 1000; // cap at ±5 min — reject obvious outliers

// Stage 5: run-speed config.
const MAX_SPEED_OBS       = 10;        // keep last N run-speed observations per job
const LEAD_TIME_BUFFER_MS = 15_000;   // 15 s safety margin on top of measured lead time
// Bounds on the derived neededLeadTimeMs so it stays reasonable.
const MIN_LEAD_TIME_MS    = 20_000;   // floor: always arm at least 20 s before window
const MAX_LEAD_TIME_MS    = 3 * 60_000; // ceiling: never extend beyond 3 min

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

// ── Class 1: Window-open offset API ──────────────────────────────────────────

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
 *   learnedOffsetMs:        number,
 *   adjustedArmedOffsetMs:  number,
 *   adjustedWarmupOffsetMs: number,
 *   observationCount:       number,
 * } | null}
 */
function getLearnedOffsets(jobId, { WARMUP_OFFSET_MS, ARMED_OFFSET_MS }) {
  const data  = loadData();
  const key   = String(jobId);
  const entry = data[key];
  if (!entry || entry.observations.length < MIN_OBS) return null;

  const offsets         = entry.observations.map(o => o.offsetMs);
  const learnedOffsetMs = median(offsets);

  const adjustedArmedOffsetMs  = Math.max(0, ARMED_OFFSET_MS  - learnedOffsetMs);
  const adjustedWarmupOffsetMs = Math.max(0, WARMUP_OFFSET_MS - learnedOffsetMs);

  return {
    learnedOffsetMs,
    adjustedArmedOffsetMs,
    adjustedWarmupOffsetMs,
    observationCount: offsets.length,
  };
}

// ── Class 2: Run-speed API (Stage 5) ─────────────────────────────────────────

/**
 * Record how long a bot run took to move from run_start to class-discovered,
 * broken into the three measured phases from Stage 3 timing metrics.
 *
 * Call after every burst preflight run where timingMetrics are available.
 * Safe to call with null values — they are stored as null and excluded from
 * median computation.
 *
 * @param {number} jobId
 * @param {{
 *   authMs:      number | null,   — auth_phase_ms from timingMetrics
 *   pageLoadMs:  number | null,   — run_start_to_page_ready
 *   discoveryMs: number | null,   — page_ready_to_class_found
 *   classTitle:  string | null,
 * }} opts
 */
function recordRunSpeed(jobId, { authMs, pageLoadMs, discoveryMs, classTitle }) {
  // Skip if there is nothing meaningful to record.
  if (authMs == null && pageLoadMs == null) return;

  const data = loadData();
  const key  = String(jobId);
  if (!data[key]) data[key] = { classTitle: classTitle ?? null, observations: [] };
  data[key].classTitle  = classTitle ?? data[key].classTitle;
  if (!data[key].runSpeeds) data[key].runSpeeds = [];

  data[key].runSpeeds.push({
    authMs:      authMs      ?? null,
    pageLoadMs:  pageLoadMs  ?? null,
    discoveryMs: discoveryMs ?? null,
    recordedAt:  new Date().toISOString(),
  });

  if (data[key].runSpeeds.length > MAX_SPEED_OBS) {
    data[key].runSpeeds = data[key].runSpeeds.slice(-MAX_SPEED_OBS);
  }

  saveData(data);

  const totalMs = (authMs ?? 0) + (pageLoadMs ?? 0) + (discoveryMs ?? 0);
  console.log(
    `[timing-learner] run-speed:record — Job #${jobId} ` +
    `auth=${Math.round((authMs   ?? 0) / 1000)}s ` +
    `page=${Math.round((pageLoadMs ?? 0) / 1000)}s ` +
    `disc=${Math.round((discoveryMs ?? 0) / 1000)}s ` +
    `total=${Math.round(totalMs / 1000)}s ` +
    `n=${data[key].runSpeeds.length}/${MAX_SPEED_OBS}.`
  );
}

/**
 * Compute the minimum lead time the bot needs to be ready to click when the
 * booking window opens, based on measured run-speed observations.
 *
 * Returns null when there are fewer than MIN_OBS run-speed observations.
 *
 * @param {number} jobId
 * @returns {{
 *   medianAuthMs:      number,
 *   medianPageLoadMs:  number,
 *   medianDiscoveryMs: number,
 *   medianTotalMs:     number,
 *   neededLeadTimeMs:  number,   — clamped to [MIN_LEAD_TIME_MS, MAX_LEAD_TIME_MS]
 *   observationCount:  number,
 * } | null}
 */
function getLearnedRunSpeed(jobId) {
  const data  = loadData();
  const key   = String(jobId);
  const entry = data[key];
  if (!entry?.runSpeeds?.length || entry.runSpeeds.length < MIN_OBS) return null;

  const authNums      = entry.runSpeeds.map(r => r.authMs).filter(v => v != null);
  const pageLoadNums  = entry.runSpeeds.map(r => r.pageLoadMs).filter(v => v != null);
  const discoveryNums = entry.runSpeeds.map(r => r.discoveryMs).filter(v => v != null);

  const medianAuthMs      = authNums.length      ? median(authNums)      : 0;
  const medianPageLoadMs  = pageLoadNums.length   ? median(pageLoadNums)  : 0;
  const medianDiscoveryMs = discoveryNums.length  ? median(discoveryNums) : 0;
  const medianTotalMs     = medianAuthMs + medianPageLoadMs + medianDiscoveryMs;

  const rawLeadTime    = medianTotalMs + LEAD_TIME_BUFFER_MS;
  const neededLeadTimeMs = Math.min(
    Math.max(rawLeadTime, MIN_LEAD_TIME_MS),
    MAX_LEAD_TIME_MS
  );

  return {
    medianAuthMs,
    medianPageLoadMs,
    medianDiscoveryMs,
    medianTotalMs,
    neededLeadTimeMs,
    observationCount: entry.runSpeeds.length,
  };
}

// ── Summary (for API / diagnostics) ──────────────────────────────────────────

/**
 * Return a summary of all learned timing data (for API / diagnostics).
 *
 * @returns {Array<{
 *   jobId, classTitle,
 *   observationCount, medianOffsetMs, lastRecordedAt,
 *   runSpeedCount, medianRunSpeedMs, neededLeadTimeMs,
 * }>}
 */
function loadLearnerSummary() {
  const data = loadData();
  return Object.entries(data).map(([jobId, entry]) => {
    const offsets = (entry.observations ?? []).map(o => o.offsetMs);
    const speeds  = (entry.runSpeeds    ?? []);
    const speedTotals = speeds.map(
      s => (s.authMs ?? 0) + (s.pageLoadMs ?? 0) + (s.discoveryMs ?? 0)
    );

    let medianRunSpeedMs  = null;
    let neededLeadTimeMs  = null;
    if (speeds.length >= MIN_OBS) {
      const med           = median(speedTotals);
      medianRunSpeedMs    = med;
      const raw           = med + LEAD_TIME_BUFFER_MS;
      neededLeadTimeMs    = Math.min(Math.max(raw, MIN_LEAD_TIME_MS), MAX_LEAD_TIME_MS);
    }

    return {
      jobId:            Number(jobId),
      classTitle:       entry.classTitle ?? null,
      observationCount: offsets.length,
      medianOffsetMs:   offsets.length ? median(offsets) : null,
      lastRecordedAt:   entry.observations?.at(-1)?.recordedAt ?? null,
      runSpeedCount:    speeds.length,
      medianRunSpeedMs,
      neededLeadTimeMs,
    };
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  recordObservation,
  getLearnedOffsets,
  recordRunSpeed,
  getLearnedRunSpeed,
  loadLearnerSummary,
};
