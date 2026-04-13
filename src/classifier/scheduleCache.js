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
const MAX_AGE_MS  = 4 * 60 * 60 * 1000;  // 4 hours — fresh enough for same-day use

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

// Find the best matching entry for a given job.
// Matching priority: title (required) + date (strong) + time (strong).
// Returns null if no acceptable match found.
function findEntry(job) {
  const raw = loadAll();
  if (!raw || isCacheStale(raw)) return null;

  const { classTitle, targetDate, classTime } = job;
  if (!classTitle) return null;

  const normTitle = (s = '') => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const normTime  = (s = '') => s.toLowerCase().replace(/\s+/g, '').replace(/\./g, '');

  const titleKey = normTitle(classTitle);
  const timeKey  = normTime(classTime || '');

  const candidates = raw.entries.filter(e => normTitle(e.title).includes(titleKey) || titleKey.includes(normTitle(e.title)));

  if (candidates.length === 0) return null;

  // Prefer entries on the exact target date.
  const onDate = targetDate ? candidates.filter(e => e.dateISO === targetDate) : candidates;
  const pool   = onDate.length > 0 ? onDate : candidates;

  // Among pool, prefer the one whose time best matches.
  if (timeKey) {
    const byTime = pool.find(e => normTime(e.timeLocal).includes(timeKey) || timeKey.includes(normTime(e.timeLocal)));
    if (byTime) return byTime;
  }

  // Fall back to closest date if no time match.
  return pool[0] ?? null;
}

module.exports = { saveEntries, mergeAndSaveEntries, loadAll, isCacheStale, findEntry };
