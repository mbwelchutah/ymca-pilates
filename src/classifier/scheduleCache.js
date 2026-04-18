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

const { writeJsonAtomic } = require('../util/atomic-json');

const CACHE_FILE  = path.resolve(__dirname, '../data/fw-schedule-cache.json');
const MAX_AGE_MS  = 4 * 60 * 60 * 1000;  // 4 hours — stale threshold (unchanged)

// ── Freshness buckets ─────────────────────────────────────────────────────────
//
// Two independent sets of thresholds:
//   FILE-LEVEL  — measures how recently the cache file was written (savedAt).
//                 Used for whole-file bail-out checks (is the file too old to
//                 search at all?) and as a fallback when no entry was matched.
//   ENTRY-LEVEL — measures how recently a specific class entry was observed
//                 from the API (capturedAt).  Used for classifier freshness
//                 so a merge that refreshes savedAt does not make old entries
//                 appear fresh.
//
// Bucket semantics for booking decisions:
//   'fresh'   (< 30 min)  — observed very recently; strong evidence; can act
//                           authoritatively on the result (e.g. suppress warmup
//                           when class is confirmed full).
//   'aging'   (30 min–4 h)— observed a few hours ago; moderate evidence; enough
//                           to inform predictions but should not block execution
//                           or state strong certainty.
//   'stale'   (> 4 h)     — observed long ago; low evidence; must not be used
//                           as a strong blocker or authoritative claim; treat
//                           as a weak hint only.
//   'unknown' (no timestamp) — no observation time available; treat
//                           conservatively as if stale.
//
// Thresholds mirror FRESHNESS.classTruth in src/bot/confirmed-ready.js.
// Defined here independently to avoid a circular dependency.
// If the booking window semantics require different per-entry sensitivity,
// ENTRY_FRESH_MS / ENTRY_AGING_MS can be adjusted independently of the
// file-level constants without touching confirmed-ready.js.

// File-level thresholds (whole cache file)
const CACHE_FRESH_MS = 30 * 60 * 1000;          // < 30 min  → 'fresh'
const CACHE_AGING_MS = 4  * 60 * 60 * 1000;     // 30 min–4 h → 'aging'  (= MAX_AGE_MS)
// > 4 h → 'stale'

// Entry-level thresholds (individual class entry, based on capturedAt)
const ENTRY_FRESH_MS = 30 * 60 * 1000;          // < 30 min  → 'fresh'
const ENTRY_AGING_MS = 4  * 60 * 60 * 1000;     // 30 min–4 h → 'aging'
// > 4 h → 'stale'

/**
 * Bucket definitions exported for diagnostic consumers.
 * Exposes both file-level and entry-level thresholds.
 */
const FRESHNESS_THRESHOLDS = Object.freeze({
  file:  { freshMs: CACHE_FRESH_MS, agingMs: CACHE_AGING_MS },
  entry: { freshMs: ENTRY_FRESH_MS, agingMs: ENTRY_AGING_MS },
});

/**
 * Return the freshness bucket of a raw cache object (or null).
 * Based on file-level savedAt — used for whole-file bail-out checks and as
 * a fallback when no specific entry is matched.
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

/**
 * Return the freshness bucket of a single cache entry based on its own
 * capturedAt timestamp — NOT the file-level savedAt.
 *
 * Stage 2 (per-entry freshness): a merge that refreshes savedAt does not make
 * older kept entries look fresh.  Each entry's capturedAt reflects when that
 * specific class row was actually observed from the API.
 *
 * Stage 3 (formalized buckets): uses ENTRY_FRESH_MS / ENTRY_AGING_MS, which
 * are independent of the file-level constants and can be tuned separately.
 * Backward-compatible: entries without capturedAt return 'unknown'.
 *
 * @param {object|null} entry  A single schedule-cache entry.
 * @returns {'fresh'|'aging'|'stale'|'unknown'}
 */
function computeEntryFreshness(entry) {
  if (!entry?.capturedAt) return 'unknown';
  const ageMs = Date.now() - new Date(entry.capturedAt).getTime();
  if (ageMs < ENTRY_FRESH_MS) return 'fresh';
  if (ageMs < ENTRY_AGING_MS) return 'aging';
  return 'stale';
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Stage 9 (past-date eviction): returns true when dateISO is a valid
// YYYY-MM-DD string that falls strictly before today's Pacific date.
//
// Entries without a parseable dateISO (null / empty / unexpected format) are
// NOT considered past — we can't tell, so we keep them.
//
// Pacific time (America/Los_Angeles) is used because classes are at the Eugene
// YMCA.  UTC was previously used here but is wrong: Pacific is UTC-7/8, so UTC
// rolls to "tomorrow" at 5 PM PDT — 7 hours before Pacific midnight.  Using UTC
// would evict today's schedule entries after 5 PM Pacific, which is exactly when
// the evening-class booking windows are active.
function _isPastDate(dateISO) {
  if (!dateISO || typeof dateISO !== 'string') return false;
  // Reject anything that doesn't look like YYYY-MM-DD to avoid stray matches.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return false;
  // en-CA locale gives "YYYY-MM-DD" format directly.
  const todayPacific = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  }).format(new Date());
  return dateISO < todayPacific; // lexicographic comparison is correct for ISO dates
}

// ── Write helpers ─────────────────────────────────────────────────────────────

function saveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const payload = { savedAt: new Date().toISOString(), entries };
    writeJsonAtomic(CACHE_FILE, payload);
  } catch (e) {
    console.warn('[schedule-cache] save failed:', e.message);
  }
}

// Merge new entries with any existing ones (replace matching date+title pairs).
// Stage 9: also evicts past-date entries from the kept set so the cache
// does not accumulate indefinitely.  Entries in newEntries are written as-is
// (the caller is responsible for their dateISO correctness).
function mergeAndSaveEntries(newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) return;
  const existing = loadAll()?.entries ?? [];
  const key = e => `${e.dateISO}|${(e.title || '').toLowerCase().trim()}`;
  const newKeys = new Set(newEntries.map(key));
  const kept    = existing.filter(e => !newKeys.has(key(e)) && !_isPastDate(e.dateISO));
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
      // Stage 9: skip entries for class dates that are strictly in the past.
      // A past date can never be the target of an upcoming booking; keeping
      // such entries in the scored set risks returning a stale result that
      // misrepresents the current schedule (e.g. last week's "full" status).
      if (_isPastDate(entry.dateISO)) return null;

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

/**
 * Returns true when the cache is fresh enough that a browser run is NOT
 * required purely for cache-refresh purposes.
 *
 * "Adequate" means fresh or aging (≤ 4 h old).  Stale (> 4 h) or missing
 * cache must trigger a browser run so schedule data is not indefinitely skipped
 * by the HTTP-ping fast path in auto-preflight.
 *
 * @returns {boolean}
 */
function isCacheAdequate() {
  const raw = loadAll();
  const f = computeCacheFreshness(raw);
  return f === 'fresh' || f === 'aging';
}

module.exports = { saveEntries, mergeAndSaveEntries, loadAll, isCacheStale, findEntry, computeCacheFreshness, computeEntryFreshness, isCacheAdequate, FRESHNESS_THRESHOLDS };
