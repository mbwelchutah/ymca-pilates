// FamilyWorks schedule cache.
//
// Populated by network response interception during Playwright preflight runs —
// each preflight already visits the schedule page, so we capture the class data
// as the API responses arrive (network layer, not DOM).
//
// The classifier reads from this cache so it can determine availability state
// without launching a new browser session.
//
// Cache shape (src/data/fw-schedule-cache.json):
// {
//   savedAt: ISO string,
//   entries: [
//     {
//       title:         string,          "Core Pilates"
//       dayOfWeek:     string,          "Friday"
//       dateISO:       string,          "2026-04-17"
//       timeLocal:     string,          "7:30 AM"
//       instructor:    string|null,     "Stephanie S."
//       location:      string|null,     "Movement Studio • Eugene Y"
//       openSpots:     number|null,     0
//       totalCapacity: number|null,     20
//       isFull:        boolean,         false
//       isWaitlist:    boolean,         false
//       isCancelled:   boolean,         false
//       isOpen:        boolean,         true
//       capturedAt:    ISO string,
//     }
//   ]
// }

const fs   = require('fs');
const path = require('path');

const CACHE_FILE  = path.resolve(__dirname, '../data/fw-schedule-cache.json');
const MAX_AGE_MS  = 4 * 60 * 60 * 1000;  // 4 hours — stale threshold (unchanged)

// ── Freshness buckets ─────────────────────────────────────────────────────────
// Three-tier freshness model for class/API/cache truth.
// Thresholds mirror FRESHNESS.classTruth in src/bot/confirmed-ready.js.
// (Defined here independently to avoid a circular dependency.)
const CACHE_FRESH_MS = 30 * 60 * 1000;          // < 30 min  → "fresh"
const CACHE_AGING_MS = 4  * 60 * 60 * 1000;     // 30 min–4 h → "aging"  (= MAX_AGE_MS)
// > 4 h → "stale"

/**
 * Return the freshness bucket of a raw cache object (or null).
 *
 * @param {object|null} raw  Return value of loadAll(), or null.
 * @returns {'fresh'|'aging'|'stale'|'unknown'}
 */
function computeCacheFreshness(raw) {
  if (!raw?.savedAt) return 'unknown';
  const ageMs = Date.now() - new Date(raw.savedAt).getTime();
  if (ageMs < CACHE_FRESH_MS) return 'fresh';
  if (ageMs < CACHE_AGING_MS) return 'aging';
  return 'stale';
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function saveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const payload = { savedAt: new Date().toISOString(), entries };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.warn('[schedule-cache] save failed:', e.message);
  }
}

// Merge new entries with any existing ones (replace matching date+title pairs).
function mergeAndSaveEntries(newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) return;
  const existing = loadAll()?.entries ?? [];
  const key = e => `${e.dateISO}|${(e.title || '').toLowerCase().trim()}`;
  const newKeys = new Set(newEntries.map(key));
  const kept    = existing.filter(e => !newKeys.has(key(e)));
  saveEntries([...kept, ...newEntries]);
}

// ── Read helpers ──────────────────────────────────────────────────────────────

function loadAll() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!raw?.savedAt || !Array.isArray(raw.entries)) return null;
    return raw;
  } catch {
    return null;
  }
}

// Returns true if the cache is older than MAX_AGE_MS.
function isCacheStale(raw) {
  if (!raw?.savedAt) return true;
  return Date.now() - new Date(raw.savedAt).getTime() > MAX_AGE_MS;
}

// ── Fuzzy scoring helpers ─────────────────────────────────────────────────────

const _normTitle = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Parse "7:30 AM" / "07:30 AM" / "730am" / "7:30a" → minutes since midnight.
// Returns NaN when unparseable.
function _timeToMinutes(s) {
  if (!s) return NaN;
  const clean = s.toLowerCase().replace(/[\s.:]/g, '');
  const m = clean.match(/^(\d{1,2})(\d{2})(am|pm|a|p)?$/);
  if (!m) return NaN;
  let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  const meridiem = m[3];
  if (meridiem === 'pm' || meridiem === 'p') { if (h !== 12) h += 12; }
  if (meridiem === 'am' || meridiem === 'a') { if (h === 12) h = 0;   }
  return h * 60 + min;
}

// Title similarity: 0–50 points.
// Returns 0 when titles share no significant words (treat as hard fail).
function _titleScore(jobTitle, entryTitle) {
  const j = _normTitle(jobTitle);
  const e = _normTitle(entryTitle);
  if (j === e) return 50;
  if (j.includes(e) || e.includes(j)) return 40;
  // Word-overlap fallback (ignore words ≤ 2 chars)
  const jW = new Set(j.split(' ').filter(w => w.length > 2));
  const eW = new Set(e.split(' ').filter(w => w.length > 2));
  if (jW.size === 0 || eW.size === 0) return 0;
  const shared = [...jW].filter(w => eW.has(w)).length;
  const ratio  = shared / Math.max(jW.size, eW.size);
  return ratio >= 0.5 ? Math.round(ratio * 30) : 0;
}

// Date similarity: 0–30 points.
function _dateScore(job, entry) {
  if (job.targetDate && entry.dateISO === job.targetDate) return 30;
  if (job.dayOfWeek && entry.dayOfWeek &&
      entry.dayOfWeek.toLowerCase() === job.dayOfWeek.toLowerCase()) return 10;
  return 0;
}

// Time similarity: 0–20 points (accepts ±30 min).
function _timeScore(job, entry) {
  const jMin = _timeToMinutes(job.classTime);
  const eMin = _timeToMinutes(entry.timeLocal);
  if (isNaN(jMin) || isNaN(eMin)) return 0;
  const diff = Math.abs(jMin - eMin);
  if (diff === 0)   return 20;
  if (diff <= 15)   return 15;
  if (diff <= 30)   return 8;
  return 0;            // > 30 min difference — no time credit
}

// TIME_FUZZY_LIMIT_MIN: entries with time diff > this are excluded entirely.
const TIME_FUZZY_LIMIT_MIN = 30;

// ── findEntry ─────────────────────────────────────────────────────────────────
//
// Find the best matching cache entry for a job description.
//
// Returns: { entry, matchType: 'exact'|'fuzzy', confidence: 0-100 }
//       OR null if no acceptable match.
//
// matchType 'exact'   — title exact + target date exact + time exact (≡ 0 min diff)
// matchType 'fuzzy'   — at least title matched; date or time used tolerance
//
// Minimum confidence to return a match: 30 (title overlap + at least partial date)
//
function findEntry(job) {
  const raw = loadAll();
  if (!raw || isCacheStale(raw)) return null;
  if (!job?.classTitle) return null;

  const jTimeMins = _timeToMinutes(job.classTime);

  const scored = raw.entries
    .map(entry => {
      const ts = _titleScore(job.classTitle, entry.title);
      if (ts === 0) return null;  // Hard title mismatch — skip entirely

      // Exclude entries whose time differs by more than the fuzzy limit.
      if (!isNaN(jTimeMins)) {
        const eMins = _timeToMinutes(entry.timeLocal);
        if (!isNaN(eMins) && Math.abs(jTimeMins - eMins) > TIME_FUZZY_LIMIT_MIN) return null;
      }

      const ds = _dateScore(job, entry);
      const tis = _timeScore(job, entry);
      const score = ts + ds + tis;

      // Determine match type
      const exactTitle = _normTitle(entry.title) === _normTitle(job.classTitle);
      const exactDate  = job.targetDate && entry.dateISO === job.targetDate;
      const exactTime  = tis === 20;  // 20 pts = 0 min difference
      const matchType  = (exactTitle && exactDate && exactTime) ? 'exact' : 'fuzzy';

      return { entry, score, matchType };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const best = scored[0];
  if (best.score < 30) return null;  // Below minimum confidence — treat as no match

  // Map raw score (0–100) to a 0–100 confidence value.
  // Max achievable score is 50+30+20 = 100.
  const confidence = Math.min(100, Math.round(best.score));

  return { entry: best.entry, matchType: best.matchType, confidence };
}

module.exports = { saveEntries, mergeAndSaveEntries, loadAll, isCacheStale, findEntry, computeCacheFreshness };
