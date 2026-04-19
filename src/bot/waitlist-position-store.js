'use strict';
// waitlist-position-store.js — Task #101
//
// Tiny disk-backed map of jobId → { position, capturedAt } so the most
// recently observed FW waitlist badge ("#10 On Waitlist") can be surfaced
// on the Now / Tools UI for as long as last_result === 'waitlist'.
//
// Deliberately *not* a DB schema change: positions are an enrichment, not
// a source of truth. The file is tolerant of missing/corrupt content
// (returns nulls) and writes are best-effort.
//
// Usage:
//   const positions = require('./waitlist-position-store');
//   positions.set(jobId, 10);
//   positions.get(jobId);   // 10  (or null)
//   positions.clear(jobId); // forget on reset

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE     = path.join(DATA_DIR, 'waitlist-positions.json');

function _readAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function _writeAll(map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.warn('[waitlist-position-store] write failed (non-fatal):', err.message);
  }
}

function get(jobId) {
  if (jobId == null) return null;
  const all = _readAll();
  const row = all[String(jobId)];
  if (!row || typeof row.position !== 'number' || !Number.isFinite(row.position)) return null;
  return row.position;
}

function set(jobId, position) {
  if (jobId == null) return;
  if (position == null || !Number.isFinite(position)) return;
  const all = _readAll();
  all[String(jobId)] = { position, capturedAt: new Date().toISOString() };
  _writeAll(all);
}

function clear(jobId) {
  if (jobId == null) return;
  const all = _readAll();
  if (all[String(jobId)]) {
    delete all[String(jobId)];
    _writeAll(all);
  }
}

module.exports = { get, set, clear, FILE };
