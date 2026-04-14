// Shared class truth classifier.
//
// Accepts a planned class/job description and returns a normalized ClassTruth
// result.  This module is the single source of truth for class availability
// BEFORE Playwright execution runs.  Both Plan and Now screens consume it.
//
// Implementation stages:
//   Stage 1 (this file): module skeleton, state constants, result shape
//   Stage 2: FamilyWorks API data fetch via saved session cookies
//   Stage 3: normalized availability classification from API response
//   Stage 4: fuzzy matching for time/name shifts
//   Stage 5: enriched output shape for UI rendering

// ── Normalized states ─────────────────────────────────────────────────────────
//
// bookable          — spots available; registration is open or will open shortly
// waitlist_available— class is full but a waitlist can be joined
// full              — no open spots and no waitlist (or waitlist also full)
// already_registered— the authenticated user is already enrolled in this class
// not_found         — no acceptable class match found on the schedule
// unknown           — classification could not be determined (API error, no data)

const CLASS_STATES = Object.freeze({
  BOOKABLE:           'bookable',
  WAITLIST_AVAILABLE: 'waitlist_available',
  FULL:               'full',
  ALREADY_REGISTERED: 'already_registered',
  NOT_FOUND:          'not_found',
  UNKNOWN:            'unknown',
});

// ── Result factory ────────────────────────────────────────────────────────────
//
// All fields are always present so consumers never need null-guard optional
// chaining on the result shape.
//
// state            {string}       — one of CLASS_STATES
// matchedClassName {string|null}  — class title from the schedule as matched
// matchedInstructor{string|null}  — instructor name from the schedule
// matchedTime      {string|null}  — time string from the schedule (e.g. "7:30 AM")
// matchedDate      {string|null}  — ISO date string of the matched occurrence
// confidence       {number}       — 0–100 match confidence score
// isFuzzyMatch     {boolean}      — true if match required fuzzy tolerance
// matchType        {string}       — 'exact' | 'fuzzy' | 'none'
// openSpots        {number|null}  — available spots (null = not provided by API)
// totalCapacity    {number|null}  — class capacity  (null = not provided by API)
// reason           {string|null}  — human-readable explanation for the state
// fetchedAt        {string|null}  — ISO timestamp when the API data was fetched
// freshness        {string}       — 'fresh'|'aging'|'stale'|'unknown' (Stage 2)
// source           {string}       — 'cache'|'playwright'|'live_api'|'unknown' (Stage 2)
function makeResult(state, partial = {}) {
  return {
    state,
    matchedClassName:   partial.matchedClassName   ?? null,
    matchedInstructor:  partial.matchedInstructor  ?? null,
    matchedTime:        partial.matchedTime        ?? null,
    matchedDate:        partial.matchedDate        ?? null,
    confidence:         partial.confidence         ?? 0,
    isFuzzyMatch:       partial.isFuzzyMatch       ?? false,
    matchType:          partial.matchType          ?? 'none',
    openSpots:          partial.openSpots          ?? null,
    totalCapacity:      partial.totalCapacity      ?? null,
    reason:             partial.reason             ?? null,
    fetchedAt:          partial.fetchedAt          ?? null,
    freshness:          partial.freshness          ?? 'unknown',
    source:             partial.source             ?? 'unknown',
  };
}

// ── Classifier entry point ────────────────────────────────────────────────────
//
// job: {
//   classTitle  {string}        e.g. "Core Pilates"
//   dayOfWeek   {string}        e.g. "Friday"
//   classTime   {string}        e.g. "7:30 AM"
//   instructor  {string|null}   e.g. "Stephanie"
//   targetDate  {string|null}   ISO date e.g. "2026-04-17"
// }
//
// Returns ClassTruthResult (synchronous)
//
// Stages 2+3: reads from the schedule cache populated by Playwright API
// response interception and maps entry booleans to normalized ClassStates.
// Returns UNKNOWN when cache is missing/stale; NOT_FOUND when no entry matches.
// Synchronous — all cache I/O uses fs.readFileSync.
//
// Stage 2: every returned result now includes `freshness` and `source`.
//   freshness — 'fresh'|'aging'|'stale'|'unknown' derived from the cache age
//   source    — 'cache' (all data today comes from Playwright-intercepted API
//                responses stored in fw-schedule-cache.json)
function classifyClass(job) {
  const { findEntry, isCacheStale, loadAll, computeCacheFreshness, computeEntryFreshness } = require('./scheduleCache');

  const raw           = loadAll();
  const fileFreshness = computeCacheFreshness(raw);  // file-level — for early bail-out checks
  const source        = raw ? 'cache' : 'unknown';

  if (!raw) {
    return makeResult(CLASS_STATES.UNKNOWN, {
      reason: 'Schedule cache does not exist — run a preflight to populate it',
      freshness: fileFreshness,
      source,
    });
  }

  if (isCacheStale(raw)) {
    return makeResult(CLASS_STATES.UNKNOWN, {
      reason: 'Schedule cache is stale — run a preflight to refresh',
      fetchedAt: raw.savedAt,
      freshness: fileFreshness,
      source,
    });
  }

  // Stage 4: use scored fuzzy findEntry (returns { entry, matchType, confidence } | null)
  const match = findEntry(job);

  if (!match) {
    // No specific entry to measure — fall back to file-level freshness.
    return makeResult(CLASS_STATES.NOT_FOUND, {
      reason: `No schedule entry matched "${job.classTitle}" on ${job.targetDate ?? job.dayOfWeek}`,
      fetchedAt: raw.savedAt,
      matchType:  'none',
      confidence: 0,
      freshness:  fileFreshness,
      source,
    });
  }

  const { entry, matchType, confidence } = match;

  // ── Stage 3+5: map entry booleans → normalized ClassState ─────────────────
  // Stage 5: `matchType`, `isFuzzyMatch`, `confidence` are now populated from
  // the scored fuzzy match so the UI can surface exact-vs-fuzzy distinction.
  // Stage 2 (per-entry freshness): freshness is now derived from entry.capturedAt
  // (when this specific class row was observed from the API), NOT from raw.savedAt
  // (when the cache file was last written).  A merge that refreshes savedAt no
  // longer makes older kept entries appear fresh.
  const entryFreshness = computeEntryFreshness(entry);  // per-entry, based on capturedAt

  const shared = {
    matchedClassName: entry.title,
    matchedInstructor:entry.instructor,
    matchedTime:      entry.timeLocal,
    matchedDate:      entry.dateISO,
    openSpots:        entry.openSpots,
    totalCapacity:    entry.totalCapacity,
    fetchedAt:        entry.capturedAt,
    matchType,
    isFuzzyMatch:     matchType === 'fuzzy',
    confidence,
    freshness:        entryFreshness,   // ← per-entry, not file-level
    source,
  };

  if (entry.isCancelled) {
    return makeResult(CLASS_STATES.NOT_FOUND, {
      ...shared,
      reason: 'Class is cancelled',
    });
  }

  if (!entry.isOpen) {
    // Not open for registration yet — still classifiable as "bookable" for
    // planning purposes (it exists and should open before booking window).
    return makeResult(CLASS_STATES.BOOKABLE, {
      ...shared,
      reason: 'Class exists but registration is not yet open',
    });
  }

  if (entry.isFull) {
    if (entry.isWaitlist) {
      return makeResult(CLASS_STATES.WAITLIST_AVAILABLE, {
        ...shared,
        openSpots: 0,
        reason: 'Class is full — waitlist is available',
      });
    }
    return makeResult(CLASS_STATES.FULL, {
      ...shared,
      openSpots: 0,
      reason: 'Class is full with no waitlist',
    });
  }

  // openSpots may be null when the API didn't return capacity detail.
  if (entry.openSpots != null && entry.openSpots <= 0) {
    return makeResult(CLASS_STATES.FULL, {
      ...shared,
      openSpots: 0,
      reason: 'No open spots remaining',
    });
  }

  return makeResult(CLASS_STATES.BOOKABLE, {
    ...shared,
    reason: entry.openSpots != null
      ? `${entry.openSpots} spot${entry.openSpots === 1 ? '' : 's'} available`
      : 'Class appears open for registration',
  });
}

module.exports = { CLASS_STATES, makeResult, classifyClass };
