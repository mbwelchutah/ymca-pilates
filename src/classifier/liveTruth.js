// Live FamilyWorks API classifier — fast, no Playwright required.
//
// Uses the saved FW session cookies (populated by Playwright auth runs and kept
// fresh by session-keepalive) to call the Bubble.io eventinstance API directly:
//   GET https://my.familyworks.app/api/1.1/obj/eventinstance
//
// The endpoint exposes everything we need to classify availability:
//   - title_text, start_date_date, end_date_date
//   - current_capacity_number / max_capacity_number / current_capacity__text__text
//   - waitlist_number_number
//   - isopen_boolean, cancelled__boolean, deleted__boolean, sub_boolean
//
// This module is the async, network-backed counterpart to classTruth.js
// (which reads a Playwright-populated cache synchronously).  When this module
// returns a confident result, the UI can flip "Unknown · checking availability"
// to "Open · Reserve available" / "Class full" / "Waitlist open" within seconds
// of the booking window opening — no browser launch needed.

const { loadCookies } = require('../bot/session-ping');

const FW_HOST     = 'my.familyworks.app';
const FW_API_BASE = `https://${FW_HOST}/api/1.1/obj/eventinstance`;
const FETCH_TIMEOUT_MS = 8_000;

// In-memory cache keyed by job id.  Each entry: { result, fetchedAt }
const _cache = new Map();
const CACHE_TTL_MS  = 30_000;   // serve cached value if newer than this
const CACHE_FAIL_MS = 60_000;   // back off this long after a failed fetch

// In-flight de-dupe so concurrent /api/state requests don't fire duplicate calls
const _inflight = new Map();

// ── Result shape ─────────────────────────────────────────────────────────────
//
// All fields are always present so the UI can render without null-guards.
//
//   state             {string}      one of LIVE_STATES
//   openSpots         {number|null} spots remaining (null = unknown)
//   totalCapacity     {number|null} class capacity (null = unknown)
//   waitlistOpen      {boolean}     true if a waitlist slot is available
//   isCancelled       {boolean}
//   isSubInstructor   {boolean}     true if this occurrence has a substitute
//   matchedTitle      {string|null} title_text from the matched API entry
//   matchedStartIso   {string|null} ISO start time from the matched entry
//   reason            {string}      human-readable explanation
//   fetchedAt         {string}      ISO timestamp of the API call
//   source            'live_api' | 'cache' | 'unknown'

const LIVE_STATES = Object.freeze({
  BOOKABLE:           'bookable',
  WAITLIST_AVAILABLE: 'waitlist_available',
  FULL:               'full',
  CANCELLED:          'cancelled',
  NOT_FOUND:          'not_found',
  UNKNOWN:            'unknown',
});

function _emptyResult(state, partial = {}) {
  return {
    state,
    openSpots:        partial.openSpots        ?? null,
    totalCapacity:    partial.totalCapacity    ?? null,
    waitlistOpen:     partial.waitlistOpen     ?? false,
    isCancelled:      partial.isCancelled      ?? false,
    isSubInstructor:  partial.isSubInstructor  ?? false,
    matchedTitle:     partial.matchedTitle     ?? null,
    matchedStartIso:  partial.matchedStartIso  ?? null,
    reason:           partial.reason           ?? '',
    fetchedAt:        partial.fetchedAt        ?? new Date().toISOString(),
    source:           partial.source           ?? 'live_api',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _cookieHeader(cookies) {
  return cookies
    .filter(c => {
      const d = (c.domain || '').replace(/^\./, '');
      return d === FW_HOST || FW_HOST.endsWith('.' + d);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

async function _fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Compute a [start, end] ISO window that bounds the next 14 days from now.
// Wider than strictly necessary because the API can have date-skew between
// when the row was authored and when it surfaces under the filter.
function _windowIso() {
  const now = Date.now();
  return {
    start: new Date(now - 24 * 3600 * 1000).toISOString(),
    end:   new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
  };
}

// Map US-style "12:00 PM" / "10:45 AM" to a 24-hour {h, m} for matching.
function _parseTimeOfDay(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { h, m: min };
}

const _DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Given a job's day_of_week + class_time + an entry's start_date_date (ISO),
// score the entry's match quality on a 0-100 scale.  100 = exact day + minute.
function _scoreEntry(job, entry) {
  if (!entry?.start_date_date) return 0;
  const startDate = new Date(entry.start_date_date);
  if (isNaN(startDate.getTime())) return 0;

  // Compare day-of-week and time in Pacific (the YMCA's local zone).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday:  'long',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(startDate);

  const partWeekday = fmt.find(p => p.type === 'weekday')?.value || '';
  const partHour    = fmt.find(p => p.type === 'hour')?.value;
  const partMinute  = fmt.find(p => p.type === 'minute')?.value;
  const entryDow    = _DAY_INDEX[partWeekday.toLowerCase()];
  const entryHM     = (partHour != null && partMinute != null)
    ? { h: parseInt(partHour, 10) % 24, m: parseInt(partMinute, 10) }
    : null;

  let score = 0;

  // Day-of-week — required.  Off by one day = 0.
  const wantDow = _DAY_INDEX[(job.dayOfWeek || '').toLowerCase()];
  if (wantDow == null || entryDow == null) return 0;
  if (wantDow !== entryDow) return 0;
  score += 50;

  // Time-of-day — exact minute = +50, within 15 min = +30, within 60 = +10.
  const wantHM = _parseTimeOfDay(job.classTime);
  if (wantHM && entryHM) {
    const deltaMin = Math.abs((wantHM.h * 60 + wantHM.m) - (entryHM.h * 60 + entryHM.m));
    if (deltaMin === 0) score += 50;
    else if (deltaMin <= 15) score += 30;
    else if (deltaMin <= 60) score += 10;
  }

  return score;
}

// Parse "<b>17/30</b>" → { current: 17, max: 30 }.  Falls back to numeric
// fields if the formatted string isn't present or parseable.
function _parseCapacity(entry) {
  const text = (entry.current_capacity__text__text || '').replace(/<[^>]+>/g, '');
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { current: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  const cur = (typeof entry.current_capacity_number === 'number') ? entry.current_capacity_number : null;
  const max = (typeof entry.max_capacity_number     === 'number') ? entry.max_capacity_number     : null;
  return { current: cur, max };
}

// ── Live fetch ───────────────────────────────────────────────────────────────

async function _fetchEntriesByTitle(title) {
  const cookies = loadCookies();
  if (!cookies || cookies.length === 0) {
    throw new Error('no-cookies');
  }
  const cookie = _cookieHeader(cookies);
  if (!cookie) throw new Error('no-fw-cookies');

  const { start, end } = _windowIso();
  const constraints = [
    { key: 'title_text',     constraint_type: 'equals',       value: title },
    { key: 'start_date_date',constraint_type: 'greater than', value: start },
    { key: 'start_date_date',constraint_type: 'less than',    value: end   },
  ];
  const url = FW_API_BASE +
    '?limit=20&sort_field=start_date_date&descending=false' +
    '&constraints=' + encodeURIComponent(JSON.stringify(constraints));

  const res = await _fetchWithTimeout(url, {
    method:  'GET',
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; YMCA-Bot/1.0)',
    },
    redirect: 'follow',
  });

  if (res.status === 401 || res.status === 403) throw new Error(`fw-auth-${res.status}`);
  if (res.status !== 200)                       throw new Error(`fw-http-${res.status}`);

  const body = await res.json().catch(() => null);
  const results = body?.response?.results;
  if (!Array.isArray(results)) throw new Error('fw-bad-body');
  return results;
}

// ── Public: classify a job ───────────────────────────────────────────────────

async function fetchLive(job) {
  const fetchedAt = new Date().toISOString();

  // Filter for live entries only (not soft-deleted by FW).
  const entries = (await _fetchEntriesByTitle(job.classTitle))
    .filter(e => !e.deleted__boolean);

  if (entries.length === 0) {
    return _emptyResult(LIVE_STATES.NOT_FOUND, {
      reason:    `No "${job.classTitle}" found in FamilyWorks within the next 14 days.`,
      fetchedAt,
    });
  }

  // Score every entry; pick the highest non-zero match.
  let best = null;
  let bestScore = 0;
  for (const e of entries) {
    const s = _scoreEntry(job, e);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  if (!best || bestScore < 50) {
    return _emptyResult(LIVE_STATES.NOT_FOUND, {
      reason: `No "${job.classTitle}" matching ${job.dayOfWeek} ${job.classTime} found in FamilyWorks.`,
      fetchedAt,
    });
  }

  const cap = _parseCapacity(best);
  const openSpots = (cap.current != null && cap.max != null)
    ? Math.max(0, cap.max - cap.current)
    : null;
  const waitlistAvailable = (typeof best.waitlist_number_number === 'number')
    && best.waitlist_number_number > 0;

  const shared = {
    openSpots,
    totalCapacity:   cap.max,
    isCancelled:     !!best.cancelled__boolean,
    isSubInstructor: !!best.sub_boolean,
    matchedTitle:    best.title_text || null,
    matchedStartIso: best.start_date_date || null,
    fetchedAt,
  };

  if (best.cancelled__boolean) {
    return _emptyResult(LIVE_STATES.CANCELLED, {
      ...shared,
      reason: 'FamilyWorks reports this class as cancelled.',
    });
  }

  if (openSpots === 0) {
    if (waitlistAvailable) {
      return _emptyResult(LIVE_STATES.WAITLIST_AVAILABLE, {
        ...shared,
        waitlistOpen: true,
        reason: `Class is full (${cap.current}/${cap.max}); waitlist available.`,
      });
    }
    return _emptyResult(LIVE_STATES.FULL, {
      ...shared,
      reason: `Class is full (${cap.current}/${cap.max}); no waitlist.`,
    });
  }

  if (openSpots == null) {
    return _emptyResult(LIVE_STATES.UNKNOWN, {
      ...shared,
      reason: 'Class found but FamilyWorks did not return capacity.',
    });
  }

  return _emptyResult(LIVE_STATES.BOOKABLE, {
    ...shared,
    reason: `${openSpots} of ${cap.max} spot${openSpots === 1 ? '' : 's'} available.`,
  });
}

// ── Cache management ─────────────────────────────────────────────────────────

// Sync read of cached value.  Returns null if nothing has been fetched yet, or
// a stamped result otherwise.  Adds an `ageMs` field for staleness display.
function getCached(jobId) {
  const entry = _cache.get(jobId);
  if (!entry) return null;
  return { ...entry.result, ageMs: Date.now() - entry.fetchedAtMs };
}

// Returns true if the cached value (if any) is older than CACHE_TTL_MS or
// absent.  Failed fetches are remembered for CACHE_FAIL_MS to avoid hammering.
function _shouldRefresh(jobId) {
  const entry = _cache.get(jobId);
  if (!entry) return true;
  const ttl = entry.failed ? CACHE_FAIL_MS : CACHE_TTL_MS;
  return (Date.now() - entry.fetchedAtMs) >= ttl;
}

// Async fetch + cache.  De-dupes concurrent calls per job id.  Never throws —
// failures are written into the cache as UNKNOWN with a `failed: true` flag.
async function refresh(job) {
  const jobId = job.id;
  if (!jobId) return null;

  if (_inflight.has(jobId)) return _inflight.get(jobId);

  const work = (async () => {
    try {
      const result = await fetchLive({
        classTitle: job.class_title,
        dayOfWeek:  job.day_of_week,
        classTime:  job.class_time,
        instructor: job.instructor,
      });
      _cache.set(jobId, { result, fetchedAtMs: Date.now(), failed: false });
      return result;
    } catch (err) {
      const result = _emptyResult(LIVE_STATES.UNKNOWN, {
        reason: `FamilyWorks API check failed: ${err.message}`,
        source: 'live_api',
      });
      _cache.set(jobId, { result, fetchedAtMs: Date.now(), failed: true });
      return result;
    } finally {
      _inflight.delete(jobId);
    }
  })();

  _inflight.set(jobId, work);
  return work;
}

// Convenience: refresh in the background if the cache is stale; never blocks.
function refreshIfStale(job) {
  if (_shouldRefresh(job.id)) {
    refresh(job).catch(() => {});
  }
}

module.exports = {
  LIVE_STATES,
  fetchLive,
  refresh,
  refreshIfStale,
  getCached,
};
