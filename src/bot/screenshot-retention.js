// Screenshot retention — prunes data/screenshots/ to prevent unbounded disk growth.
//
// Policy:
//   - Date directories older than MAX_AGE_DAYS are deleted entirely.
//   - If the total file count across all remaining directories exceeds MAX_TOTAL,
//     oldest files (by directory/filename sort order) are removed until under cap.
//   - Legacy flat screenshots/ directory is never touched (it is no longer written to).
//
// Called once at server startup and then every 24 h via setInterval.

const fs   = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = path.join(__dirname, '../../data/screenshots');
const MAX_AGE_DAYS    = 7;    // delete any date-directory older than this
const MAX_TOTAL_FILES = 200;  // hard cap across all surviving directories

/**
 * Delete screenshots older than MAX_AGE_DAYS, then trim total to MAX_TOTAL_FILES.
 * Safe to call when the directory does not exist yet.
 *
 * @returns {{ deleted: number, kept: number }}
 */
function pruneOldScreenshots() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) return { deleted: 0, kept: 0 };

  const cutoffMs = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  // ── Phase 1: remove directories older than MAX_AGE_DAYS ──────────────────
  let allDirs;
  try {
    allDirs = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort();  // oldest first (lexicographic = chronological for ISO dates)
  } catch (e) {
    console.error('[screenshot-retention] Cannot read screenshots dir:', e.message);
    return { deleted: 0, kept: 0 };
  }

  for (const dirName of allDirs) {
    const dirMs = Date.parse(dirName);
    if (isNaN(dirMs) || dirMs >= cutoffMs) continue;

    const dirPath = path.join(SCREENSHOTS_DIR, dirName);
    try {
      const files = fs.readdirSync(dirPath);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dirPath, f)); deleted++; } catch { /* skip */ }
      }
      fs.rmdirSync(dirPath);
      console.log(`[screenshot-retention] Removed ${dirName} (${files.length} files)`);
    } catch (e) {
      console.error(`[screenshot-retention] Failed to remove ${dirName}:`, e.message);
    }
  }

  // ── Phase 2: apply total-file cap ────────────────────────────────────────
  // Re-scan surviving directories so the cap reflects the post-Phase-1 state.
  const survivingDirs = (() => {
    try {
      return fs.readdirSync(SCREENSHOTS_DIR)
        .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
        .sort();
    } catch { return []; }
  })();

  // Collect all files with their full paths, sorted oldest-dir → oldest-file.
  const allFiles = [];
  for (const dirName of survivingDirs) {
    const dirPath = path.join(SCREENSHOTS_DIR, dirName);
    try {
      const names = fs.readdirSync(dirPath).sort();
      for (const f of names) allFiles.push(path.join(dirPath, f));
    } catch { /* skip unreadable dirs */ }
  }

  const excess = allFiles.length - MAX_TOTAL_FILES;
  if (excess > 0) {
    const toRemove = allFiles.slice(0, excess);  // oldest first
    for (const filePath of toRemove) {
      try {
        fs.unlinkSync(filePath);
        deleted++;
        // Remove parent dir if now empty.
        const dir = path.dirname(filePath);
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* skip */ }
    }
    console.log(`[screenshot-retention] Cap exceeded — removed ${excess} oldest files`);
  }

  const kept = Math.max(0, allFiles.length - Math.max(0, excess));
  return { deleted, kept };
}

module.exports = { pruneOldScreenshots };
