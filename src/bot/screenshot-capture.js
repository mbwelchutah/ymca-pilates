'use strict';
// screenshot-capture.js — reusable Playwright failure screenshot utility.
//
// Saves structured failure screenshots to:
//   data/screenshots/{YYYY-MM-DD}/{jobId}_{phase}_{reason}_{timestamp}.png
//
// Usage:
//   const { captureFailureScreenshot, screenshotRelPath } = require('./screenshot-capture');
//   const filePath = await captureFailureScreenshot(page, {
//     jobId:     1,
//     className: 'Core Pilates',
//     phase:     'modal',
//     reason:    'modal_not_found',
//   });
//   // filePath → '/path/to/data/screenshots/2026-04-10/job1_modal_modal_not_found_1744000000000.png'
//   // or null if capture failed (non-fatal)

const fs   = require('fs');
const path = require('path');

const DATA_DIR        = path.resolve(__dirname, '../data');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

// Max screenshots per date directory before pruning oldest.
const MAX_PER_DAY = 50;

/**
 * Capture a failure or uncertainty screenshot with structured naming.
 *
 * @param {import('playwright').Page} page        Playwright Page object
 * @param {object} ctx
 * @param {number|string|null} [ctx.jobId]        DB job ID
 * @param {string|null}        [ctx.className]    Human-readable class title
 * @param {string}             [ctx.phase]        'auth' | 'scan' | 'modal' | 'verify' | 'booking' | 'preflight'
 * @param {string}             [ctx.reason]       snake_case reason code, e.g. 'modal_not_found'
 * @param {number|null}        [ctx.timestamp]    Epoch ms; defaults to Date.now()
 * @returns {Promise<string|null>} Absolute path to saved file, or null on failure.
 */
async function captureFailureScreenshot(page, ctx = {}) {
  const { jobId = null, phase = 'unknown', reason = 'unknown', timestamp = null } = ctx;
  try {
    if (!page || typeof page.screenshot !== 'function') {
      console.warn('[screenshot-capture] No valid page object — skipping capture.');
      return null;
    }

    const ts   = timestamp ?? Date.now();
    const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
    const dir  = path.join(SCREENSHOTS_DIR, date);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Build a filesystem-safe filename component.
    const safe = (s) => String(s ?? 'x').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 28);

    const parts = [
      jobId != null ? `job${safe(jobId)}` : null,
      safe(phase),
      safe(reason),
      String(ts),
    ].filter(Boolean);

    const filename = parts.join('_') + '.png';
    const filePath = path.join(dir, filename);

    await page.screenshot({ path: filePath, fullPage: true });

    // Prune oldest files in this day's directory to cap storage.
    _pruneDir(dir, MAX_PER_DAY);

    return filePath;
  } catch (err) {
    console.warn('[screenshot-capture] capture failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Convert an absolute screenshot path to the relative URL path served by the API.
 * e.g. /path/to/data/screenshots/2026-04-10/job1_modal_modal_not_found_...png
 *   → /api/screenshots/2026-04-10/job1_modal_modal_not_found_...png
 *
 * Returns null if screenshotPath is null or outside SCREENSHOTS_DIR.
 */
function screenshotUrl(screenshotPath) {
  if (!screenshotPath) return null;
  try {
    const rel = path.relative(SCREENSHOTS_DIR, path.resolve(screenshotPath));
    // Reject any path that escapes the screenshots directory.
    if (rel.startsWith('..')) return null;
    return `/api/screenshots/${rel.replace(/\\/g, '/')}`;
  } catch {
    return null;
  }
}

/**
 * Convert an absolute path to a relative path from SCREENSHOTS_DIR.
 * Useful for storing a compact reference in the DB.
 * Returns null on failure.
 */
function screenshotRelPath(screenshotPath) {
  if (!screenshotPath) return null;
  try {
    const rel = path.relative(SCREENSHOTS_DIR, path.resolve(screenshotPath));
    if (rel.startsWith('..')) return null;
    return rel.replace(/\\/g, '/');
  } catch {
    return null;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _pruneDir(dir, maxFiles) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    const excess = files.length - maxFiles;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(dir, files[i].name)); } catch (_) {}
    }
  } catch (_) {}
}

module.exports = { captureFailureScreenshot, screenshotUrl, screenshotRelPath, SCREENSHOTS_DIR };
