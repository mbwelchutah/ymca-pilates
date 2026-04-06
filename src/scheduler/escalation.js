// Stage 10D — click_failed escalation module
//
// When the bot clicks the Register button but cannot confirm the outcome
// (click_failed), the retry strategy stops retrying to avoid blind double-
// clicks.  This module persists a lightweight escalation record so the user
// is informed through the UI that manual verification is needed.
//
// Data shape written to src/data/escalation.json:
//   {
//     "<jobId>": {
//       jobId:          number,
//       classTitle:     string,
//       classTime:      string | null,
//       reason:         "click_failed",
//       escalatedAt:    ISO string,
//       executionPhase: string,
//       attemptNumber:  number
//     },
//     ...
//   }
//
// Exports:
//   setEscalation(jobId, payload)  — write/update record for a job
//   clearEscalation(jobId)         — remove record for a job (on success)
//   loadEscalations()              — return the full map (or {})
//
// Log prefix: [escalation]

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.resolve(__dirname, '../data');
const ESC_FILE   = path.join(DATA_DIR, 'escalation.json');

// ── File helpers ──────────────────────────────────────────────────────────────

function loadEscalations() {
  try {
    if (!fs.existsSync(ESC_FILE)) return {};
    return JSON.parse(fs.readFileSync(ESC_FILE, 'utf8'));
  } catch { return {}; }
}

function saveEscalations(map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ESC_FILE, JSON.stringify(map, null, 2));
  } catch (e) {
    console.warn('[escalation] saveEscalations failed:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write or update an escalation record for the given job.
 *
 * @param {number} jobId
 * @param {{
 *   classTitle:     string,
 *   classTime:      string | null,
 *   reason:         string,
 *   executionPhase: string,
 *   attemptNumber:  number,
 * }} payload
 */
function setEscalation(jobId, payload) {
  const map = loadEscalations();
  const key = String(jobId);

  map[key] = {
    jobId:          Number(jobId),
    classTitle:     payload.classTitle     ?? null,
    classTime:      payload.classTime      ?? null,
    reason:         payload.reason         ?? 'click_failed',
    escalatedAt:    new Date().toISOString(),
    executionPhase: payload.executionPhase ?? 'unknown',
    attemptNumber:  payload.attemptNumber  ?? 1,
  };

  saveEscalations(map);
  console.log(
    `[escalation] set — Job #${jobId} (${payload.classTitle ?? '?'}) ` +
    `reason=${payload.reason ?? 'click_failed'} ` +
    `phase=${payload.executionPhase ?? 'unknown'} ` +
    `attempt=${payload.attemptNumber ?? 1}.`
  );
}

/**
 * Remove the escalation record for the given job.
 * Call this on any successful booking result.
 *
 * @param {number} jobId
 */
function clearEscalation(jobId) {
  const map = loadEscalations();
  const key = String(jobId);
  if (!map[key]) return; // nothing to clear
  delete map[key];
  saveEscalations(map);
  console.log(`[escalation] clear — Job #${jobId} escalation resolved.`);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { setEscalation, clearEscalation, loadEscalations };
